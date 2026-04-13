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
    exclude_range: List[int] = None # [start_idx, end_idx]

class AnalyzeResponse(BaseModel):
    forecast: List[float]
    anomalies: List[int]
    low: List[float] = None # 10th percentile
    high: List[float] = None # 90th percentile
    counterfactual: List[float] = None # Counterfactual values for the entire range (if exclude_range provided)

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

@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: PredictRequest):
    global tfm
    if len(req.data) == 0:
        raise HTTPException(status_code=400, detail="Data array cannot be empty")
        
    try:
        response_dict = {"forecast": [], "anomalies": []}
        
        if tfm is not None:
            # 1. Normal Forecast
            forecast, full_forecast = tfm.forecast([req.data], freq=[0])
            response_dict["forecast"] = forecast[0][:req.forecast_length].tolist()
            
            # Extract 10th and 90th percentiles
            # full_forecast index: 0=mean, 1=0.1, ..., 9=0.9
            response_dict["low"] = full_forecast[0, :req.forecast_length, 1].tolist()
            response_dict["high"] = full_forecast[0, :req.forecast_length, 9].tolist()
            
            # 2. Counterfactual Estimation (if exclude_range provided)
            if req.exclude_range and len(req.exclude_range) == 2:
                s_idx, e_idx = req.exclude_range
                if 0 < s_idx < len(req.data):
                    # Data before the event
                    context = req.data[:s_idx]
                    # we want to predict from s_idx to the end of data + forecast_length
                    total_pred_len = (len(req.data) - s_idx) + req.forecast_length
                    
                    cf_forecast, _ = tfm.forecast([context], freq=[0])
                    # Note: TimesFM by default might have a limit on horizon_len (e.g. 128). 
                    # If total_pred_len > 128, it might be truncated. 
                    # But for "effect estimation" we usually care about the event window.
                    response_dict["counterfactual"] = cf_forecast[0][:total_pred_len].tolist()

            # 3. Anomaly Detection
            W = 16
            anomalies = []
            eval_points = min(len(req.data) - W, 64)
            if eval_points > 0:
                start_idx = len(req.data) - eval_points
                batch_inputs = [req.data[i-W:i] for i in range(start_idx, len(req.data))]
                actuals = [req.data[i] for i in range(start_idx, len(req.data))]
                indices = list(range(start_idx, len(req.data)))
                
                ano_forecasts, _ = tfm.forecast(batch_inputs, freq=[0]*len(batch_inputs))
                predictions_1step = [f[0] for f in ano_forecasts]
                
                import math
                errors = [abs(p - a) for p, a in zip(predictions_1step, actuals)]
                mean_err = sum(errors) / len(errors)
                std_err = math.sqrt(sum((e - mean_err)**2 for e in errors) / len(errors)) if len(errors)>1 else 0
                threshold = mean_err + 2.5 * std_err
                
                for idx, err in zip(indices, errors):
                    if err > threshold and err > 0.01:
                        anomalies.append(idx)
            response_dict["anomalies"] = anomalies

        else:
            # MOCK MODE
            import time
            time.sleep(0.5)
            window = req.data[-5:]
            current_mean = sum(window) / len(window)
            forecast_out = [current_mean + (i * 0.1) for i in range(req.forecast_length)]
            response_dict["forecast"] = forecast_out
            response_dict["low"] = [f - 0.5 for f in forecast_out]
            response_dict["high"] = [f + 0.5 for f in forecast_out]
            response_dict["anomalies"] = [len(req.data)-2] if len(req.data)>2 else []
            
            if req.exclude_range:
                # Mock counterfactual: simple linear continuation
                s_idx = req.exclude_range[0]
                base_val = req.data[s_idx - 1] if s_idx > 0 else req.data[0]
                total_len = (len(req.data) - s_idx) + req.forecast_length
                response_dict["counterfactual"] = [base_val] * total_len

        return response_dict
            
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
