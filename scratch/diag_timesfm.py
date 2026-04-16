import os
import sys
import numpy as np
import torch
import timesfm

def test():
    print("--- TimesFM 2.5 Diagnostic Script ---")
    model_id = "google/timesfm-2.5-200m-pytorch"
    try:
        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(model_id, torch_compile=False)
        model.compile(
            timesfm.ForecastConfig(
                max_context=1024,
                max_horizon=128,
                per_core_batch_size=32,
                normalize_inputs=True,
                return_backcast=True,
            )
        )
        
        # Simulate user data: 100 points around 75
        data_len = 100
        data = (np.random.rand(data_len) * 10 + 70).astype(np.float32)
        
        horizon = 24
        print(f"Input len: {data_len}, Horizon: {horizon}")
        
        res = model.forecast(inputs=[data], horizon=horizon)
        p, q = res
        
        print(f"Point shape: {p.shape}")
        print(f"Quantile shape: {q.shape}")
        
        # Check first and last few points of point forecast
        print(f"First 5: {p[0, :5]}")
        print(f"Last 5: {p[0, -5:]}")
        
        # Check median (index 5)
        median = q[0, :, 5]
        print(f"Median shape: {median.shape}")
        
        if p.shape[1] > horizon:
            print(f"Detected Backcast + Forecast. Split index: {data_len}")
            backcast_part = p[0, :data_len]
            forecast_part = p[0, data_len:]
            print(f"Backcast Mean: {np.mean(backcast_part):.2f}")
            print(f"Forecast Mean: {np.mean(forecast_part):.2f}")
        else:
            print("Detected Forecast ONLY.")

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test()
