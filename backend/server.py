import os
import shutil
import json
import asyncio
import subprocess
from typing import List
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pypdf

app = FastAPI()

# CORS configuration
origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Directories
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
CHECKPOINT_DIR = os.path.join(BASE_DIR, "checkpoints")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(CHECKPOINT_DIR, exist_ok=True)

class ProcessRequest(BaseModel):
    filename: str

from openai import OpenAI

# ... imports ...

class ChatRequest(BaseModel):
    message: str
    api_key: str

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    file_path = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    return {"filename": file.filename, "status": "uploaded"}

def generate_qa_pairs(text: str) -> List[dict]:
    """
    Generates dummy QA pairs from text for demonstration.
    In a real scenario, this would use an LLM.
    """
    words = text.split()
    chunk_size = 50
    chunks = [" ".join(words[i:i + chunk_size]) for i in range(0, len(words), chunk_size)]
    
    data = []
    for i, chunk in enumerate(chunks):
        if len(chunk) < 10:
            continue
        # Trivial QA pair generation
        item = {
            "data_type": "qa",
            "question": [f"What is the content of chunk {i+1}?"],
            "answers": [chunk],
            "docs": [chunk]  # The document is the chunk itself in this trivial case
        }
        data.append(item)
    return data

@app.post("/process")
async def process_file(request: ProcessRequest):
    filenames = request.filenames
    
    total_qa_pairs = 0
    all_qa_data = []

    for filename in filenames:
        file_path = os.path.join(UPLOAD_DIR, filename)
        
        if not os.path.exists(file_path):
            print(f"File not found: {filename}, skipping.")
            continue
        
        # Step 1: Read and Generate QA pairs
        try:
            text = ""
            if filename.lower().endswith(".pdf"):
                reader = pypdf.PdfReader(file_path)
                for page in reader.pages:
                    extracted = page.extract_text()
                    if extracted:
                        text += extracted + "\n"
            else:
                with open(file_path, "r", encoding="utf-8") as f:
                    text = f.read()
            
            if text.strip():
                qa_data = generate_qa_pairs(text)
                all_qa_data.extend(qa_data)
                
        except Exception as e:
             print(f"Error processing {filename}: {e}")
             # Continue with other files even if one fails
             continue

    if not all_qa_data:
        raise HTTPException(status_code=400, detail="No valid content extracted from uploaded files.")
    
    # Step 1: Append to Knowledge Base
    # We append to the jsonl file so multiple files can be supported.
    with open(KB_FILE, "a") as f:
        for item in all_qa_data:
            f.write(json.dumps(item) + "\n")
            
    # Step 2: Trigger Actual Training
    try:
        # Define the command
        script_path = os.path.join(BASE_DIR, "scripts", "train_pretraining_local.sh")
        
        # Run the script
        process = subprocess.run(
            ["bash", script_path],
            cwd=BASE_DIR,
            capture_output=True,
            text=True
        )
        
        if process.returncode != 0:
            print(f"Training failed: {process.stderr}")
            return {
                "status": "training_failed_but_processed", 
                "qa_pairs_generated": len(all_qa_data), 
                "training_log": process.stderr[-500:],
                "message": "Training script failed. Chat will use openrouter without fine-tuned weights."
            }
            
    except Exception as e:
         print(f"Error running training: {e}")
         return {
             "status": "error", 
             "error": str(e)
         }

    return {"status": "processed", "qa_pairs_generated": len(all_qa_data), "training_status": "complete"}

@app.post("/flush")
async def flush_db():
    try:
        if os.path.exists(KB_FILE):
            os.remove(KB_FILE)
        
        # Also maybe clear checkpoints if we want a fresh start
        checkpoints_dir = os.path.join(BASE_DIR, "checkpoints")
        if os.path.exists(checkpoints_dir):
            shutil.rmtree(checkpoints_dir)
            
        return {"status": "flushed", "message": "Knowledge base and checkpoints cleared."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/db_status")
async def get_db_status():
    count = 0
    if os.path.exists(KB_FILE):
        with open(KB_FILE, "r") as f:
            count = sum(1 for line in f)
    return {"count": count}

@app.post("/chat")
async def chat(request: ChatRequest):
    if not request.api_key:
        raise HTTPException(status_code=400, detail="API Key is required")

    # Load Knowledge Base
    jsonl_path = os.path.join(DATA_DIR, "pretrain_data.jsonl")
    knowledge_chunks = []
    if os.path.exists(jsonl_path):
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    data = json.loads(line)
                    # Support both list and string formats for docs/answers
                    docs = data.get("docs", [])
                    if isinstance(docs, list):
                        knowledge_chunks.extend(docs)
                    elif isinstance(docs, str):
                         knowledge_chunks.append(docs)
                except:
                    continue

    # Simple Retrieval: keyword overlap
    query_words = set(request.message.lower().split())
    scored_chunks = []
    for chunk in knowledge_chunks:
        chunk_words = set(chunk.lower().split())
        score = len(query_words.intersection(chunk_words))
        scored_chunks.append((score, chunk))
    
    # Get top 3 chunks
    scored_chunks.sort(key=lambda x: x[0], reverse=True)
    top_chunks = [chunk for score, chunk in scored_chunks[:3] if score > 0]
    
    context = "\n\n".join(top_chunks)
    
    system_prompt = "You are a helpful assistant. Use the following context to answer the user's question. If the answer is not in the context, say so."
    user_prompt = f"Context:\n{context}\n\nQuestion: {request.message}"

    try:
        client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=request.api_key,
        )
        
        completion = client.chat.completions.create(
            extra_headers={
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "CLaRa Chat",
            },
            model="google/gemini-2.0-flash-001",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        response_text = completion.choices[0].message.content
    except Exception as e:
        print(f"Error calling OpenRouter: {e}")
        response_text = f"Error: Failed to get response from AI provider. {str(e)}"
    
    return {"response": response_text}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
