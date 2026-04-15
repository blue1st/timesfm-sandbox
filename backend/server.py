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
from typing import List, Optional

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
    exclude_range: Optional[List[int]] = None
    anomaly_threshold: float = 2.5 # Used as quantile index or sigma

class AnalyzeResponse(BaseModel):
    forecast: List[float]
    anomalies: List[int]
    low: Optional[List[float]] = None
    high: Optional[List[float]] = None
    counterfactual: Optional[List[float]] = None

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
    server_debug_log(f"--- Analyze START: data_len={len(req.data)}, threshold={req.anomaly_threshold} ---")
    
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

        # 2. Counterfactual
        if req.exclude_range and len(req.exclude_range) == 2:
            s_idx = req.exclude_range[0]
            if 0 < s_idx < len(req.data):
                context = req.data[:s_idx]
                total_pred_len = (len(req.data) - s_idx) + req.forecast_length
                cf_point, _ = tfm.forecast(horizon=min(total_pred_len, 256), inputs=[np.array(context)])
                response_dict["counterfactual"] = clean_list(cf_point[0][:total_pred_len])

        # 3. Pure TimesFM Anomaly Detection
        try:
            # We use a sliding window context and 1-step ahead forecasting to evaluate each point.
            # This is "Pure" because it relies entirely on the model's prediction and uncertainty (quantiles).
            
            ctx_len = 512 # Use a generous context window for better accuracy
            min_ctx = 32  # Minimum points needed to start detecting
            
            anomalies = []
            if len(req.data) > min_ctx:
                server_debug_log(f"Pure Anomaly detection start for {len(req.data)} points")
                
                batch_inputs = []
                actuals = []
                indices = []
                
                # Prepare all evaluation points
                for i in range(min_ctx, len(req.data)):
                    context = req.data[max(0, i - ctx_len):i]
                    batch_inputs.append(np.array(context))
                    actuals.append(req.data[i])
                    indices.append(i)
                
                # Process in batches to balance speed and memory
                batch_size = 64
                for i in range(0, len(batch_inputs), batch_size):
                    b_inputs = batch_inputs[i : i + batch_size]
                    b_actuals = actuals[i : i + batch_size]
                    b_indices = indices[i : i + batch_size]
                    
                    # 1-step ahead forecast with quantiles
                    _, quantiles = tfm.forecast(horizon=1, inputs=b_inputs)
                    
                    for idx, act, q_row in zip(b_indices, b_actuals, quantiles):
                        # TimesFM 2.5 Quantiles: 0=Mean, 1=0.1, 5=0.5 (Median), 9=0.9
                        q_median = q_row[0, 5]
                        q_low = q_row[0, 1]
                        q_high = q_row[0, 9]
                        
                        # Calculate a normalized deviation score based on the model's own uncertainty (quantile width)
                        # A width of (q_high - q_low) covers 80% of the distribution.
                        # For a normal distribution, this is ~2.56 sigma.
                        q_width = max(1e-6, q_high - q_low)
                        
                        # Standardized Score: (Deviation from Median) / (Half-Width)
                        # If threshold = 1.0, it roughly flags items outside the 80% interval.
                        score = abs(act - q_median) / (q_width / 2.0)
                        
                        if score > req.anomaly_threshold:
                            anomalies.append(idx)
                
                response_dict["anomalies"] = anomalies
                server_debug_log(f"Pure Anomaly Detection SUCCESS: {len(anomalies)} anomalies found")
        except Exception as e:
            server_debug_log(f"Anomaly detection WARNING: {e}")
            traceback.print_exc()

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
    port_str = os.environ.get("PORT", "8000")
    try:
        actual_port = int(port_str)
        server_debug_log(f"--- SERVER STARTING on port {actual_port} ---")
        uvicorn.run(app, host="0.0.0.0", port=actual_port)
    except Exception as e:
        server_debug_log(f"FATAL STARTUP ERROR: {e}")
        server_debug_log(traceback.format_exc())
        sys.exit(1)
