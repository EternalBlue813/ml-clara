import os
import shutil
import json
from typing import List
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pypdf
from openai import OpenAI

app = FastAPI()

# CORS configuration
origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    # Allow Vercel deployments
    "https://ml-clara.vercel.app",
    "https://ml-clara-git-main-eternalblue813.vercel.app",
    "https://ml-clara-eternalblue813.vercel.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow all for Vercel preview URLs to work easily
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Directories - Use /tmp for Vercel (Ephemeral)
UPLOAD_DIR = "/tmp/uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Knowledge Base file path - also ephemeral
KB_FILE = "/tmp/pretrain_data.jsonl"

class ProcessRequest(BaseModel):
    filenames: List[str]

class ChatRequest(BaseModel):
    message: str
    api_key: str

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "environment": "vercel"}

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        file_path = os.path.join(UPLOAD_DIR, file.filename)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        return {"filename": file.filename, "status": "uploaded"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def generate_qa_pairs(text: str) -> List[dict]:
    """
    Generates dummy QA pairs from text for demonstration.
    """
    words = text.split()
    chunk_size = 50
    chunks = [" ".join(words[i:i + chunk_size]) for i in range(0, len(words), chunk_size)]
    
    data = []
    for i, chunk in enumerate(chunks):
        if len(chunk) < 10:
            continue
        item = {
            "data_type": "qa",
            "question": [f"What is the content of chunk {i+1}?"],
            "answers": [chunk],
            "docs": [chunk]
        }
        data.append(item)
    return data

@app.post("/api/process")
async def process_file(request: ProcessRequest):
    filenames = request.filenames
    
    all_qa_data = []

    for filename in filenames:
        file_path = os.path.join(UPLOAD_DIR, filename)
        
        if not os.path.exists(file_path):
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
             continue

    if not all_qa_data:
        raise HTTPException(status_code=400, detail="No valid content extracted from uploaded files.")
    
    # Step 1: Append to Knowledge Base
    try:
        with open(KB_FILE, "a") as f:
            for item in all_qa_data:
                f.write(json.dumps(item) + "\n")
    except Exception as e:
        print(f"Error writing to KB: {e}")
            
    # Step 2: Skip Actual Training (Not supported on Vercel)
    # We return success but with a message about limitations
    return {
        "status": "processed", 
        "qa_pairs_generated": len(all_qa_data), 
        "training_status": "skipped_on_vercel",
        "message": "Files processed and added to ephemeral memory. Training skipped (Vercel CPU limitation)."
    }

@app.post("/api/flush")
async def flush_db():
    try:
        if os.path.exists(KB_FILE):
            os.remove(KB_FILE)
            
        return {"status": "flushed", "message": "Knowledge base cleared."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/db_status")
async def get_db_status():
    count = 0
    if os.path.exists(KB_FILE):
        with open(KB_FILE, "r") as f:
            count = sum(1 for line in f)
    return {"count": count}

@app.post("/api/chat")
async def chat(request: ChatRequest):
    if not request.api_key:
        raise HTTPException(status_code=400, detail="API Key is required")

    # Load Knowledge Base
    knowledge_chunks = []
    if os.path.exists(KB_FILE):
        with open(KB_FILE, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    data = json.loads(line)
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
                "HTTP-Referer": "https://ml-clara.vercel.app",
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
