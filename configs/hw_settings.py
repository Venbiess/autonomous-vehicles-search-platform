from types import SimpleNamespace

MASTER_SERVER_CONFIG = SimpleNamespace(
)

TORCH_CONFIG = SimpleNamespace(
    TORCH_VERSION="2.9.1",  # https://pytorch.org/get-started/previous-versions/
    TORCH_CUDA_TAG="cpu",   # cpu | cu121 | cu124 | etc. You can find out the cuda version of your machine 
                            # using nvcc --version or nvidia-smi. Choose "cpu" if you are not using cuda
    HF_HOME="/app/.cache/huggingface"  # Path to huggingface cache dir.
)

EMBEDDER_CONFIG = SimpleNamespace(
    PORT=8000,
    DEVICE="CPU",           # CPU, CUDA, MPS
)

VLM_CONFIG = SimpleNamespace(
    PORT=9000,
    DEVICE="CPU",           # CPU, CUDA, MPS
)