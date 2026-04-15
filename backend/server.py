import os
import sys
import logging
import threading
import datetime
import traceback
import gc

# --- FORCE NUMPY LOAD FIRST ---
def server_debug_log(msg):
    try:
        debug_path = os.path.expanduser("~/Desktop/timesfm_debug.txt")
        pid = os.getpid()
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(debug_path, "a") as f:
            f.write(f"[{timestamp}] [PID:{pid}] [server.py] {msg}\n")
    except:
        pass

# Force CPU inference for stability in packaged environment
os.environ["JAX_PLATFORMS"] = "cpu"
os.environ["TORCH_NUMPY_PREFER_ENV"] = "1"

try:
    import numpy as np
    sys.modules['numpy'] = np
    import numpy.core.multiarray as multiarray
    sys.modules['numpy.core.multiarray'] = multiarray
    server_debug_log(f"Numpy {np.__version__} loaded successfully")
    
    import torch
    # FORCE HACK: Tell torch that numpy is definitely available
    try:
        torch.has_numpy = True
    except:
        pass
    server_debug_log(f"Torch {torch.__version__} loaded. has_numpy={getattr(torch, 'has_numpy', 'N/A')}")
except Exception as e:
    server_debug_log(f"CRITICAL: Early import failed: {e}")
    server_debug_log(traceback.format_exc())
# ------------------------------

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class PredictRequest(BaseModel):
    data: List[float]
    forecast_length: int = 20
    exclude_range: List[int] = None

class AnalyzeResponse(BaseModel):
    forecast: List[float]
    anomalies: List[int]
    low: List[float] = None
    high: List[float] = None
    counterfactual: List[float] = None

# Global state
tfm = None
is_loading = False
loading_error = None
current_model_id = "google/timesfm-2.5-200m-pytorch"
ALL_MODEL_IDS = ["google/timesfm-2.5-200m-pytorch"]

def load_model_task(model_id: str):
    global tfm, is_loading, loading_error, current_model_id
    is_loading = True
    loading_error = None
    server_debug_log(f"--- Model Load Task START: {model_id} ---")

    if tfm is not None:
        server_debug_log("Cleaning up previous tfm instance...")
        del tfm
        tfm = None
        gc.collect()

    current_model_id = model_id

    try:
        server_debug_log("Starting timesfm import...")
        import timesfm
        server_debug_log("timesfm module imported. Loading weights from hub...")

        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(
            model_id,
            torch_compile=False,
        )
        server_debug_log("Model instance created. Starting compilation...")
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
        server_debug_log(f"--- Model Load Task SUCCESS: {model_id} ---")
    except Exception as e:
        loading_error = str(e)
        server_debug_log(f"--- Model Load Task FAILED: {e} ---")
        server_debug_log(traceback.format_exc())
    finally:
        is_loading = False

@app.on_event("startup")
def startup_event():
    thread = threading.Thread(target=load_model_task, args=(current_model_id,))
    thread.start()

@app.post("/init_model")
def init_model(model_id: str):
    global is_loading
    if model_id not in ALL_MODEL_IDS:
        raise HTTPException(status_code=400, detail=f"Invalid model ID: {model_id}")
    if is_loading:
        raise HTTPException(status_code=409, detail="Model is already loading")
    thread = threading.Thread(target=load_model_task, args=(model_id,))
    thread.start()
    return {"status": "started", "model_id": model_id}

@app.get("/status")
def get_status():
    if tfm: return {"status": "ready", "message": "Model is loaded.", "model_id": current_model_id}
    if is_loading: return {"status": "loading", "message": "Model is loading...", "model_id": current_model_id}
    if loading_error: return {"status": "error", "message": loading_error, "model_id": current_model_id}
    return {"status": "idle", "message": "Model pending.", "model_id": current_model_id}

@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: PredictRequest):
    global tfm
    server_debug_log(f"--- Analyze START: data_len={len(req.data)} ---")
    
    try:
        import numpy as np
        import torch
        sys.modules['numpy'] = np
        try: torch.has_numpy = True
        except: pass
            
        if tfm is None:
            server_debug_log("Analyze ERROR: tfm is None")
            raise HTTPException(status_code=503, detail="Model not initialized")
            
        # 1. Main Forecast
        inputs = [np.array(req.data)]
        point_forecast, quantile_forecast = tfm.forecast(
            horizon=req.forecast_length,
            inputs=inputs,
        )
        server_debug_log(f"Inference SUCCESS: point_shape={point_forecast.shape}")
        
        # Convert to list and clean NaNs
        def clean_list(arr):
            lst = arr.tolist()
            return [0.0 if (x is None or (not isinstance(x, str) and (x != x or x == float('inf') or x == float('-inf')))) else x for x in lst]

        forecast_list = clean_list(point_forecast[0][:req.forecast_length])
        low_list = clean_list(quantile_forecast[0, :req.forecast_length, 1])
        high_list = clean_list(quantile_forecast[0, :req.forecast_length, 9])

        response_dict = {
            "forecast": forecast_list,
            "low": low_list,
            "high": high_list,
            "anomalies": [],
            "counterfactual": None
        }
        server_debug_log("Main forecast converted to list.")

        # 2. Counterfactual (Optional)
        if req.exclude_range and len(req.exclude_range) == 2:
            s_idx = req.exclude_range[0]
            if 0 < s_idx < len(req.data):
                server_debug_log(f"Counterfactual start: s_idx={s_idx}")
                context = req.data[:s_idx]
                total_pred_len = (len(req.data) - s_idx) + req.forecast_length
                cf_point, _ = tfm.forecast(horizon=min(total_pred_len, 256), inputs=[np.array(context)])
                response_dict["counterfactual"] = clean_list(cf_point[0][:total_pred_len])
                server_debug_log("Counterfactual finished.")

        # 3. Anomaly Detection (with safety block)
        try:
            W = 16
            eval_points = min(len(req.data) - W, 64)
            if eval_points > 0:
                server_debug_log(f"Anomaly detection start: eval_points={eval_points}")
                start_idx = len(req.data) - eval_points
                batch_inputs = [np.array(req.data[i-W:i]) for i in range(start_idx, len(req.data))]
                actuals = [req.data[i] for i in range(start_idx, len(req.data))]
                indices = list(range(start_idx, len(req.data)))
                
                ano_points, _ = tfm.forecast(horizon=1, inputs=batch_inputs)
                predictions_1step = ano_points[:, 0].tolist()
                
                import math
                errors = [abs(p - a) for p, a in zip(predictions_1step, actuals)]
                mean_err = sum(errors) / len(errors)
                std_err = math.sqrt(sum((e - mean_err)**2 for e in errors) / len(errors)) if len(errors)>1 else 0
                threshold = mean_err + 2.5 * std_err
                
                anomalies = []
                for idx, err in zip(indices, errors):
                    if err > threshold and err > 0.01:
                        anomalies.append(idx)
                response_dict["anomalies"] = anomalies
                server_debug_log(f"Anomaly detection SUCCESS: count={len(anomalies)}")
        except Exception as e:
            server_debug_log(f"Anomaly detection WARNING (skipped): {e}")

        server_debug_log("--- Response ready to return ---")
        return response_dict
            
    except Exception as e:
        server_debug_log(f"Analyze EXCEPTION: {e}")
        server_debug_log(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

from gcp_service import authenticate_gcp, query_bigquery, read_gcs_csv

@app.get("/gcp/auth")
def auth_gcp():
    try: authenticate_gcp(); return {"status": "success"}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.post("/gcp/bigquery")
def bq_query(req: dict):
    try: return {"csv": query_bigquery(req['query'], req['project_id'])}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.post("/gcp/gcs")
def gcs_fetch(req: dict):
    try: return {"csv": read_gcs_csv(req['gs_url'])}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))
