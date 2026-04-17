import { getBackendUrl } from './backend';

export async function analyzeTimeSeries(
  data: number[], 
  forecastLength: number = 20, 
  excludeRange?: [number, number],
  sensitivity: number = 2.5,
  covariates?: number[],
  anomalyMinCtx: number = 16,
  anomalyWidthMultiplier: number = 0.5,
  contextMultiple: number = 32,
  effectiveHorizon: number = 128
): Promise<{forecast: number[], anomalies: number[], low?: number[], high?: number[], counterfactual?: number[]}> {
  console.log("Requesting TimesFM analysis from Python Backend...");
  
  const baseUrl = await getBackendUrl();
  let response;
  try {
    response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data,
        forecast_length: forecastLength,
        exclude_range: excludeRange,
        anomaly_threshold: sensitivity,
        covariates: covariates,
        anomaly_min_ctx: anomalyMinCtx,
        anomaly_width_multiplier: anomalyWidthMultiplier,
        context_multiple: contextMultiple,
        effective_horizon: effectiveHorizon
      }),
    });
  } catch (err) {
    console.error("Failed to connect to Python backend:", err);
    throw new Error(`バックエンドサーバー(${baseUrl})に接続できません。サーバーの起動状態（ポート ${baseUrl.split(':').pop()}）を確認してください。`);
  }

  if (!response.ok) {
    let errorDetail = response.statusText;
    try {
      const errorData = await response.json();
      if (errorData.detail) errorDetail = typeof errorData.detail === 'string' ? errorData.detail : JSON.stringify(errorData.detail);
    } catch (e) {}
    throw new Error(errorDetail);
  }
  
  const result = await response.json();
  return { 
    forecast: result.forecast, 
    anomalies: result.anomalies,
    low: result.low,
    high: result.high,
    counterfactual: result.counterfactual 
  };
}
