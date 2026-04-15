import os
import sys
import logging
import threading

# --- FORCE NUMPY LOAD FIRST ---
def server_debug_log(msg):
    try:
        with open(os.path.expanduser("~/Desktop/timesfm_debug.txt"), "a") as f:
            f.write(f"[server.py] {msg}\n")
    except:
        pass

try:
    import numpy as np
    # Essential for torch to find numpy in some PyInstaller environments
    sys.modules['numpy'] = np
    import numpy.core.multiarray as multiarray
    sys.modules['numpy.core.multiarray'] = multiarray
    
    server_debug_log(f"Numpy {np.__version__} loaded successfully from {np.__file__}")
except Exception as e:
    server_debug_log(f"CRITICAL: Numpy import failed: {e}")

# Pre-set torch environment variables before ANY other import
os.environ["TORCH_NUMPY_PREFER_ENV"] = "1"
# ------------------------------


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

import gc

# Global state
tfm = None
is_loading = False
loading_error = None
current_model_id = "google/timesfm-2.5-200m-pytorch" # Default

# Supported model IDs
ALL_MODEL_IDS = [
    "google/timesfm-2.5-200m-pytorch",
]


def load_model_task(model_id: str):
    global tfm, is_loading, loading_error, current_model_id
    is_loading = True
    loading_error = None

    # Thorough cleanup of existing model
    if tfm is not None:
        logger.info("Background: Cleaning up previous model instance...")
        del tfm
        tfm = None
        gc.collect()

    current_model_id = model_id

    logger.info(f"Background: Loading TimesFM 2.5 model: {model_id}")
    try:
        import timesfm

        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(
            model_id,
            torch_compile=False,  # Disable torch.compile for CPU / Apple Silicon compatibility
        )
        model.compile(
            timesfm.ForecastConfig(
                max_context=1024,
                max_horizon=256,
                per_core_batch_size=32,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                infer_is_positive=True,
                fix_quantile_crossing=True,
            )
        )
        tfm = model
        logger.info(f"Background: {model_id} loaded successfully.")
    except Exception as e:
        loading_error = str(e)
        logger.error(f"Background: Failed to load {model_id}: {e}", exc_info=True)
    finally:
        is_loading = False


@app.on_event("startup")
def startup_event():
    # Start default model loading
    thread = threading.Thread(target=load_model_task, args=(current_model_id,))
    thread.start()

@app.post("/init_model")
def init_model(model_id: str):
    if model_id not in ALL_MODEL_IDS:
        raise HTTPException(status_code=400, detail=f"Invalid model ID: {model_id}. Available: {ALL_MODEL_IDS}")
    
    if is_loading:
        raise HTTPException(status_code=409, detail="Model is already loading")

    thread = threading.Thread(target=load_model_task, args=(model_id,))
    thread.start()
    return {"status": "started", "model_id": model_id}

@app.get("/models")
def get_available_models():
    return ALL_MODEL_IDS

@app.get("/health")
@app.get("/status")
def get_status():
    if tfm:
        return {"status": "ready", "message": "Model is loaded and ready.", "model_id": current_model_id}
    if is_loading:
        return {"status": "loading", "message": "Model is initializing/downloading...", "model_id": current_model_id}
    if loading_error:
        return {"status": "error", "message": loading_error, "model_id": current_model_id}
    return {"status": "idle", "message": "Model initialization pending.", "model_id": current_model_id}

@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: PredictRequest):
    global tfm
    if len(req.data) == 0:
        raise HTTPException(status_code=400, detail="Data array cannot be empty")
        
    try:
        import numpy as np
        
        response_dict = {"forecast": [], "anomalies": []}
        
        if tfm is None:
            raise HTTPException(status_code=503, detail="TimesFMモデルの初期化に失敗しています。バックエンドのログを確認してください。")
            
        # 1. Normal Forecast using TimesFM 2.5 API
        inputs = [np.array(req.data)]
        point_forecast, quantile_forecast = tfm.forecast(
            horizon=req.forecast_length,
            inputs=inputs,
        )
        # point_forecast: (batch, horizon)
        # quantile_forecast: (batch, horizon, 10) — [mean, 0.1, 0.2, ..., 0.9]
        response_dict["forecast"] = point_forecast[0][:req.forecast_length].tolist()
        response_dict["low"] = quantile_forecast[0, :req.forecast_length, 1].tolist()   # 10th percentile
        response_dict["high"] = quantile_forecast[0, :req.forecast_length, 9].tolist()  # 90th percentile
        
        # 2. Counterfactual Estimation (if exclude_range provided)
        if req.exclude_range and len(req.exclude_range) == 2:
            s_idx, e_idx = req.exclude_range
            if 0 < s_idx < len(req.data):
                # Data before the event
                context = req.data[:s_idx]
                # We want to predict from s_idx to the end of data + forecast_length
                total_pred_len = (len(req.data) - s_idx) + req.forecast_length
                # Clamp to max_horizon (256)
                cf_horizon = min(total_pred_len, 256)

                cf_point, _ = tfm.forecast(
                    horizon=cf_horizon,
                    inputs=[np.array(context)],
                )
                response_dict["counterfactual"] = cf_point[0][:total_pred_len].tolist()

        # 3. Anomaly Detection
        W = 16
        anomalies = []
        eval_points = min(len(req.data) - W, 64)
        if eval_points > 0:
            start_idx = len(req.data) - eval_points
            batch_inputs = [np.array(req.data[i-W:i]) for i in range(start_idx, len(req.data))]
            actuals = [req.data[i] for i in range(start_idx, len(req.data))]
            indices = list(range(start_idx, len(req.data)))
            
            ano_points, _ = tfm.forecast(horizon=1, inputs=batch_inputs)
            # ano_points shape: (num_inputs, 1) — extract 1-step predictions
            predictions_1step = ano_points[:, 0].tolist()
            
            import math
            errors = [abs(p - a) for p, a in zip(predictions_1step, actuals)]
            mean_err = sum(errors) / len(errors)
            std_err = math.sqrt(sum((e - mean_err)**2 for e in errors) / len(errors)) if len(errors)>1 else 0
            threshold = mean_err + 2.5 * std_err
            
            for idx, err in zip(indices, errors):
                if err > threshold and err > 0.01:
                    anomalies.append(idx)
        response_dict["anomalies"] = anomalies

        return response_dict
            
    except Exception as e:
        logger.error(f"Prediction error: {e}", exc_info=True)
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
    # Import verification mode: test all critical imports and exit
    if "--check" in sys.argv:
        errors = []
        for mod_name in ["numpy", "torch", "timesfm", "pandas", "fastapi", "uvicorn"]:
            try:
                mod = __import__(mod_name)
                ver = getattr(mod, "__version__", "?")
                print(f"  ✅ {mod_name} {ver}")
            except Exception as e:
                print(f"  ❌ {mod_name}: {e}")
                errors.append(mod_name)
        if errors:
            print(f"\nFAILED: {errors}")
            sys.exit(1)
        print("\nAll imports OK")
        sys.exit(0)

    import uvicorn
    # Enable running directly via `python server.py`
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port)
