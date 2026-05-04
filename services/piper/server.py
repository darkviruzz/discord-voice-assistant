from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
import subprocess, tempfile, os, signal

app = FastAPI()

# Pfade via Umgebungsvariablen konfigurierbar (werden vom Startskript gesetzt)
_piper_dir = os.environ.get("PIPER_DIR", r"C:\Programme\piper")
PIPER_EXE       = os.environ.get("PIPER_EXE",        os.path.join(_piper_dir, "piper.exe"))
PIPER_VOICES_DIR = os.environ.get("PIPER_VOICES_DIR", os.path.join(_piper_dir, "voices"))

MODELS = {
    "emotional": os.path.join(PIPER_VOICES_DIR, "de_DE-thorsten_emotional-medium.onnx"),
    "high":      os.path.join(PIPER_VOICES_DIR, "de_DE-thorsten-high.onnx"),
}

# Speaker IDs nur fuer emotional:
# 0=Frohlich 1=Wutend 2=Angewidert 3=Betrunken
# 4=Neutral  5=Schlafrig 6=Ueberrascht 7=Flusternd

class TTSRequest(BaseModel):
    text: str
    model: str = "emotional"   # "emotional" | "high"
    speaker_id: int = 4        # nur relevant wenn model="emotional"

@app.post("/synthesize")
async def synthesize(req: TTSRequest):
    model_path = MODELS.get(req.model, MODELS["emotional"])

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        outfile = f.name

    cmd = [PIPER_EXE, "--model", model_path, "--output_file", outfile]

    if req.model == "emotional":
        cmd += ["--speaker", str(req.speaker_id)]

    subprocess.run(cmd, input=req.text.encode("utf-8"), capture_output=True)

    with open(outfile, "rb") as f:
        audio = f.read()
    os.unlink(outfile)

    return Response(content=audio, media_type="audio/wav")

@app.get("/health")
async def health():
    return {"status": "ok"}
    
@app.post("/shutdown")
async def shutdown():
    os.kill(os.getpid(), signal.SIGINT)
    return {"status": "shutting down"}