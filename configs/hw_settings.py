from types import SimpleNamespace

MASTER_SERVER_CONFIG = SimpleNamespace(
)

TORCH_CONFIG = SimpleNamespace(
    TORCH_VERSION="2.9.1",  # https://pytorch.org/get-started/previous-versions/
    TORCH_CUDA_TAG="cpu",   # cpu | cu121 | cu124 | etc. You can find out the cuda version of your machine 
                            # using nvcc --version or nvidia-smi. Choose "cpu" if you are not using cuda
    HF_HOME="/app/.cache/huggingface",  # Path to huggingface cache dir.
    HF_DOWNLOAD_PROGRESS=True,  # Show HF download progress/logging
)

EMBEDDER_CONFIG = SimpleNamespace(
    PORT=8000,
    DEVICE="CPU",           # CPU, CUDA, MPS
    BACKEND="ALIGN",         # ALIGN, QWEN
    MODEL_NAME=None,  # Optional HF model id override
    TORCH_DTYPE="auto",     # auto, fp32/float32, fp16/float16, bf16/bfloat16
)

VLM_CONFIG = SimpleNamespace(
    PORT=8001,
    DEVICE="CPU",           # CPU, CUDA, MPS
    BACKEND="SMOLVLM",      # SMOLVLM, QWEN
    MODEL_NAME=None,
    TORCH_DTYPE=None,       # None => bf16 on CUDA, float32 otherwise
    ATTN_IMPLEMENTATION=None,  # Optional: flash_attention_2, sdpa, eager
)
