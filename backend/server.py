import os
import sys
import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# Allow CORS for the Electron frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model instance
tfm = None

class PredictRequest(BaseModel):
    data: List[float]
    forecast_length: int = 20

@app.on_event("startup")
def load_model():
    global tfm
    logger.info("Initializing TimesFM model... This may take a while.")
    try:
        import timesfm
        # Using 1.0-200m-pytorch variant as recommended for pure torch backends
        tfm = timesfm.TimesFm(
            hparams=timesfm.TimesFmHparams(
                backend="cpu", # Change to "gpu" if CUDA/MPS is available
                per_core_batch_size=32,
                horizon_len=128,
                context_len=512,
            ),
            checkpoint=timesfm.TimesFmCheckpoint(
                huggingface_repo_id="google/timesfm-1.0-200m-pytorch"
            ),
        )
        logger.info("TimesFM model loaded successfully.")
    except Exception as e:
        logger.error(f"Failed to load TimesFM model natively: {e}")
        logger.warning("Running in DRY/MOCK mode for UI testing. Install 'timesfm[torch]' to run the real model.")

class AnalyzeResponse(BaseModel):
    forecast: List[float]
    anomalies: List[int]  # List of indices that are flagged as anomalous

@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: PredictRequest):
    global tfm
    if len(req.data) == 0:
        raise HTTPException(status_code=400, detail="Data array cannot be empty")
        
    try:
        if tfm is not None:
            # 1. Real TimesFM future forecasting
            forecast, _ = tfm.forecast([req.data], freq=[0])
            future_result = forecast[0][:req.forecast_length].tolist()
            
            # 2. TimesFM Anomaly Detection (Rolling Step-Ahead Prediction)
            # We predict the value of data[i] using data[i-W : i]
            # If actual deviates too much from the TimesFM prediction, it's an anomaly.
            W = 16 # Context window for anomaly detection
            anomalies = []
            
            # For performance in CPU environments, limit to last 64 points for anomaly detection
            eval_points = min(len(req.data) - W, 64)
            
            if eval_points > 0:
                start_idx = len(req.data) - eval_points
                batch_inputs = []
                actuals = []
                indices = []
                
                for i in range(start_idx, len(req.data)):
                    batch_inputs.append(req.data[i-W:i])
                    actuals.append(req.data[i])
                    indices.append(i)
                
                # Batch inference
                # We need a list of freq matching the batch size
                batch_freq = [0] * len(batch_inputs)
                ano_forecasts, _ = tfm.forecast(batch_inputs, freq=batch_freq)
                
                # Extract the 1-step ahead prediction
                predictions_1step = [f[0] for f in ano_forecasts]
                
                # Calculate errors and dynamic threshold
                import math
                errors = [abs(p - a) for p, a in zip(predictions_1step, actuals)]
                mean_err = sum(errors) / len(errors)
                std_err = math.sqrt(sum((e - mean_err)**2 for e in errors) / len(errors)) if len(errors)>1 else 0
                threshold = mean_err + 2.5 * std_err
                
                for idx, err in zip(indices, errors):
                    if err > threshold and err > 0.01: # Add small epsilon to prevent flat-line sensitivity
                        anomalies.append(idx)

            return {"forecast": future_result, "anomalies": anomalies}
        else:
            # Fallback mock for development
            import time
            time.sleep(1.5)
            
            window = req.data[-5:]
            current_mean = sum(window) / len(window)
            trend = window[-1] - window[0] if len(window) > 1 else 0
            
            import random
            forecast_out = []
            for _ in range(req.forecast_length):
                noise = (random.random() - 0.5) * 5
                current_mean += (trend * 0.2)
                forecast_out.append(current_mean + noise)
                
            return {"forecast": forecast_out, "anomalies": [len(req.data)-2] if len(req.data)>2 else []}
            
    except Exception as e:
        logger.error(f"Prediction error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

from gcp_service import authenticate_gcp, query_bigquery, read_gcs_csv

class GCSRequest(BaseModel):
    gs_url: str

class BQRequest(BaseModel):
    project_id: str
    query: str

@app.get("/gcp/auth")
def auth_gcp():
    try:
        authenticate_gcp()
        return {"status": "success", "message": "Google Cloud認証に成功しました！"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/gcp/bigquery")
def bq_query(req: BQRequest):
    try:
        csv_data = query_bigquery(req.query, req.project_id)
        return {"csv": csv_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/gcp/gcs")
def gcs_fetch(req: GCSRequest):
    try:
        csv_data = read_gcs_csv(req.gs_url)
        return {"csv": csv_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    # Enable running directly via `python server.py`
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port)
