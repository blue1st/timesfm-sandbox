import os
import json
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google.cloud import bigquery, storage
import pandas as pd

SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/bigquery',
    'https://www.googleapis.com/auth/devstorage.read_only'
]

CREDENTIALS_FILE = "client_secret.json"
TOKEN_FILE = "token.json"

import google.auth

def authenticate_gcp():
    # Attempt to use Application Default Credentials (ADC) first
    try:
        creds, project = google.auth.default(scopes=SCOPES)
        if creds:
            # Check if we can actually use these creds (refresh if needed is handled by clients)
            return creds
    except google.auth.exceptions.DefaultCredentialsError:
        pass

    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS_FILE):
                raise FileNotFoundError("GCP認証情報が見つかりません。'gcloud auth application-default login' を実行するか、'client_secret.json' を配置してください。")
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        
        with open(TOKEN_FILE, 'w') as token:
            token.write(creds.to_json())
    return creds


def query_bigquery(query: str, project_id: str) -> str:
    creds = authenticate_gcp()
    client = bigquery.Client(credentials=creds, project=project_id)
    query_job = client.query(query)
    df = query_job.to_dataframe()
    return df.to_csv(index=False)

def read_gcs_csv(gs_url: str) -> str:
    creds = authenticate_gcp()
    # parse gs://bucket/path/to/file.csv
    if not gs_url.startswith("gs://"):
        raise ValueError("URLは 'gs://' から始まる必要があります。")
    parts = gs_url[5:].split("/", 1)
    bucket_name = parts[0]
    blob_name = parts[1]
    
    client = storage.Client(credentials=creds)
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    content = blob.download_as_text()
    return content
