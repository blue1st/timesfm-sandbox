import os
import sys
import numpy as np
import torch
import timesfm

def test():
    print("--- Running TimesFM 2.5 Inspect Script ---")
    model_id = "google/timesfm-2.5-200m-pytorch"
    try:
        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(
            model_id,
            torch_compile=False,
        )
        model.compile(
            timesfm.ForecastConfig(
                max_context=1024,
                max_horizon=128,
                per_core_batch_size=32,
                normalize_inputs=True,
                return_backcast=True,
            )
        )
        
        data = np.random.rand(100).astype(np.float32)
        horizon = 20
        res = model.forecast(inputs=[data], horizon=horizon)
        
        print(f"Result type: {type(res)}")
        print(f"Result length: {len(res)}")
        for i, item in enumerate(res):
            if hasattr(item, 'shape'):
                print(f"  Item {i} shape: {item.shape}")
            else:
                print(f"  Item {i} type: {type(item)}")

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test()
