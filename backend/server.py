import os
import sys
import logging
import threading
import datetime
import traceback
import gc

# --- FORCE NUMPY LOAD FIRST ---
def server_debug_log(msg):
    if os.environ.get("TIMESFM_DEBUG", "0") != "1":
        return
    try:
        debug_path = os.path.expanduser("~/Desktop/timesfm_debug.txt")
        pid = os.getpid()
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(debug_path, "a") as f:
            f.write(f"[{timestamp}] [PID:{pid}] [server.py] {msg}\n")
        print(f"[DEBUG] {msg}")
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
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: trigger model load in background
    thread = threading.Thread(target=load_model_task, args=(current_model_id,))
    thread.start()
    yield
    # Shutdown logic (if any) could go here

app = FastAPI(lifespan=lifespan)

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
    covariates: Optional[List[float]] = None # New: External regressors (0/1 for events etc)
    anomaly_min_ctx: int = 16
    anomaly_width_multiplier: float = 0.5
    context_multiple: int = 32
    effective_horizon: int = 128

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
                max_horizon=128, 
                per_core_batch_size=1, # Single-sequence inference
                normalize_inputs=True, # Recommended for stability
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                infer_is_positive=False, # We handle positivity after denormalization
                fix_quantile_crossing=True,
                return_backcast=True,
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
    if tfm: return {"status": "ready", "message": "Model is loaded.", "model_id": current_model_id, "version": "global_stats_v2"}
    if is_loading: return {"status": "loading", "message": "Model is loading...", "model_id": current_model_id}
    if loading_error: return {"status": "error", "message": loading_error, "model_id": current_model_id}
    return {"status": "idle", "message": "Model pending.", "model_id": current_model_id, "version": "global_stats_v2"}

@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: PredictRequest):
    global tfm
    server_debug_log(f"--- Analyze START: data_len={len(req.data)}, has_cov={req.covariates is not None}, threshold={req.anomaly_threshold} ---")
    
    try:
        import numpy as np
        import torch
        sys.modules['numpy'] = np
        try: torch.has_numpy = True
        except: pass
            
        if tfm is None:
            server_debug_log("Analyze ERROR: tfm is None")
            raise HTTPException(status_code=503, detail="Model not initialized")
            
        # --- 1. Sanitization & Alignment ---
        # Replace non-finite values with mean
        cleaned_data = np.array(req.data, dtype=np.float32)
        finite_mask = np.isfinite(cleaned_data)
        if not np.all(finite_mask):
            mean_val = np.mean(cleaned_data[finite_mask]) if np.any(finite_mask) else 0.0
            cleaned_data[~finite_mask] = mean_val
            
        data_len = len(cleaned_data)
        raw_mean = np.mean(cleaned_data)
        raw_std = np.std(cleaned_data) if np.std(cleaned_data) > 0 else 1.0
        
        server_debug_log(f"Inference Stats: mean={raw_mean:.2f}, std={raw_std:.2f}")

        context_multiple = req.context_multiple
        pad_len = (context_multiple - data_len % context_multiple) % context_multiple
        padded_data = np.pad(cleaned_data, (pad_len, 0), mode='edge')
        total_ctx = len(padded_data)
        
        effective_horizon = max(req.effective_horizon, req.forecast_length) 
        # Ensure it's a multiple of 32 for TimesFM 2.5 if context_multiple is 32
        if context_multiple == 32:
            effective_horizon = ((effective_horizon + 31) // 32) * 32
            
        server_debug_log(f"Alignment: data_len={data_len}, pad_len={pad_len}, total_ctx={total_ctx}, eff_horizon={effective_horizon}")

        # --- 2. Baseline Forecast & Backcast ---
        base_res = tfm.forecast(
            inputs=[padded_data],
            horizon=effective_horizon
        )
        p_torch, q_torch = base_res
        p_np = p_torch.detach().cpu().numpy() if hasattr(p_torch, 'detach') else p_torch
        q_np = q_torch.detach().cpu().numpy() if hasattr(q_torch, 'detach') else q_torch
        
        # --- 2b. Scale Detection & Denormalization ---
        # If model returned standardized values (e.g. mean ~0-5 while data is ~60+), we denormalize manually.
        out_mean = np.mean(p_np)
        if abs(out_mean) < 10.0 and abs(raw_mean) > 20.0:
            server_debug_log(f"Detected standardized scale ({out_mean:.2f}). Denormalizing...")
            base_point = p_np * raw_std + raw_mean
            base_quantiles = q_np * raw_std + raw_mean
        else:
            server_debug_log(f"Detected raw scale ({out_mean:.2f}). Skipping manual denorm.")
            base_point = p_np
            base_quantiles = q_np
        
        # Split into backcast and forecast correctly based on total_ctx
        if base_point.shape[1] > effective_horizon:
            backcast_q = base_quantiles[0, :total_ctx, :]
            forecast_p = base_point[0, total_ctx:]
            forecast_q = base_quantiles[0, total_ctx:, :]
        else:
            server_debug_log("WARNING: Model did not return prepended backcast.")
            backcast_q = None
            forecast_p = base_point[0]
            forecast_q = base_quantiles[0]

        # --- 3. Covariates (XReg) ---
        # Only use covariates if they are actually being used (not just all zeros)
        has_real_covariates = req.covariates is not None and any(v != 0 for v in req.covariates)
        
        if has_real_covariates:
            try:
                required_len = total_ctx + effective_horizon
                x_data = np.array(req.covariates, dtype=np.float32)
                if len(x_data) < required_len:
                    x_data = np.pad(x_data, (0, required_len - len(x_data)), mode='edge')
                else:
                    x_data = x_data[:required_len]
                
                # TimesFM 2.5 expects list of arrays with shape (total_len, num_covariates)
                x_input = x_data.reshape(-1, 1) # (N, 1)
                
                xreg_p, xreg_q = tfm.forecast_with_covariates(
                    inputs=[padded_data],
                    dynamic_numerical_covariates=[x_input],
                    horizon=effective_horizon
                )
                
                x_p_np = xreg_p.detach().cpu().numpy() if hasattr(xreg_p, 'detach') else xreg_p
                x_q_np = xreg_q.detach().cpu().numpy() if hasattr(xreg_q, 'detach') else xreg_q
                
                # Check scale for XReg too
                if abs(np.mean(x_p_np)) < 10.0 and abs(raw_mean) > 20.0:
                    forecast_p = x_p_np[0] * raw_std + raw_mean
                    forecast_q = x_q_np[0] * raw_std + raw_mean
                else:
                    forecast_p = x_p_np[0]
                    forecast_q = x_q_np[0]
                server_debug_log(f"XReg applied. Forecast shape: {forecast_p.shape}")
            except Exception as ex:
                server_debug_log(f"XReg ERROR (falling back to base): {ex}")
                server_debug_log(traceback.format_exc())

        # --- 4. Prepare Response ---
        def clean_list(arr):
            lst = arr.tolist() if hasattr(arr, 'tolist') else list(arr)
            return [0.0 if (x is None or (not isinstance(x, (str, int, float)) or x != x or x == float('inf') or x == float('-inf'))) else x for x in lst]

        response_dict = {
            "forecast": clean_list(forecast_p[:req.forecast_length]),
            "low": clean_list(forecast_q[:req.forecast_length, 1]), # q10
            "high": clean_list(forecast_q[:req.forecast_length, 9]), # q90
            "anomalies": [],
            "counterfactual": None
        }

        # --- 5. Counterfactual ---
        if req.exclude_range and len(req.exclude_range) == 2:
            s_idx = req.exclude_range[0]
            if 0 < s_idx < data_len:
                cf_context = cleaned_data[:s_idx]
                norm_cf_context = (cf_context - raw_mean) / raw_std
                
                # Apply same padding as baseline to respect context_multiple (required for TimesFM 2.5)
                cf_len = len(norm_cf_context)
                cf_pad_len = (context_multiple - cf_len % context_multiple) % context_multiple
                padded_cf_context = np.pad(norm_cf_context, (cf_pad_len, 0), mode='edge')
                
                total_pred_len = (data_len - s_idx) + req.forecast_length
                
                # Ensure horizon is multiple of 32 too if needed
                cf_horizon = min(total_pred_len, 512)
                if context_multiple == 32:
                    cf_horizon = ((cf_horizon + 31) // 32) * 32
                
                cf_res = tfm.forecast(
                    horizon=cf_horizon, 
                    inputs=[padded_cf_context.astype(np.float32)]
                )
                cf_p = cf_res[0].detach().cpu().numpy() if hasattr(cf_res[0], 'detach') else cf_res[0]
                
                # Manual Denormalization for Counterfactual
                cf_denorm = cf_p[0] * raw_std + raw_mean
                
                # Result includes backcast if return_backcast=True, so skip it
                # The tfm.forecast for 2.5 torch returns [Batch, total_ctx + horizon] or just [Batch, horizon]
                # Based on model configuration return_backcast=True
                if cf_p.shape[1] > cf_horizon:
                    # Skip padded backcast
                    response_dict["counterfactual"] = clean_list(cf_denorm[cf_pad_len + cf_len : cf_pad_len + cf_len + total_pred_len])
                else:
                    response_dict["counterfactual"] = clean_list(cf_denorm[:total_pred_len])

        # --- 6. Anomaly Detection (using Baseline Backcast) ---
        if backcast_q is not None:
            # Slicing off the edge-padding to match original data length
            real_backcast = backcast_q[pad_len:, :]
            anomalies = []
            min_ctx = req.anomaly_min_ctx 
            
            # width_floor to handle low-variance/static signals
            # Using a more conservative floor (0.5 sigma) to match 'Standard' sensitivity feel
            width_floor = max(req.anomaly_width_multiplier * raw_std, 1e-3)
            
            server_debug_log(f"Starting anomaly check: data_len={data_len}, backcast_len={len(real_backcast)}")
            
            for i in range(min_ctx, data_len):
                act = cleaned_data[i]
                q_row = real_backcast[i]
                
                d_median = q_row[5] # q50
                d_low = q_row[1]    # q10
                d_high = q_row[9]   # q90
                
                q_width = max(width_floor, d_high - d_low)
                
                # Distance from median normalized by uncertainty
                score = abs(act - d_median) / (q_width / 2.0 + 1e-6)
                
                if score > req.anomaly_threshold:
                    anomalies.append(i)
            
            response_dict["anomalies"] = anomalies
            server_debug_log(f"Anomaly Detection SUCCESS: {len(anomalies)} found")
        else:
            server_debug_log("Anomaly Detection SKIP: backcast_q is None")

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
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Verify imports and exit")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args, unknown = parser.parse_known_args()

    if args.debug:
        os.environ["TIMESFM_DEBUG"] = "1"

    if args.check:
        print("--- Smoke Test: Verifying Imports ---")
        try:
            import numpy as np
            import torch
            import timesfm
            print(f"✅ Numpy version: {np.__version__}")
            print(f"✅ Torch version: {torch.__version__}")
            print(f"✅ TimesFM module imported successfully")
            sys.exit(0)
        except Exception as e:
            print(f"❌ Smoke test failed: {e}")
            traceback.print_exc()
            sys.exit(1)

    try:
        server_debug_log(f"--- SERVER STARTING on port {args.port} ---")
        uvicorn.run(app, host="0.0.0.0", port=args.port)
    except Exception as e:
        server_debug_log(f"FATAL STARTUP ERROR: {e}")
        server_debug_log(traceback.format_exc())
        sys.exit(1)
