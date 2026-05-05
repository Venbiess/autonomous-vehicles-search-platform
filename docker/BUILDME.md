# Build via Docker Compose
```
cd docker/
docker compose -f ./docker-compose.yml up
```

# Install Docker and Docker Compose
```
# Update packages
sudo apt update
sudo apt upgrade -y

# Download dependecies and add Docker GPG-key
sudo apt install -y ca-certificates curl gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Add Docker
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Download Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Check Docker
sudo docker run hello-world

# Avoid using sudo
sudo usermod -aG docker $USER
newgrp docker
```

# Install NVIDIA CUDA drivers for GPU support
```
# Install Drivers
sudo apt update
sudo apt install -y ubuntu-drivers-common
sudo ubuntu-drivers autoinstall

# Reboot and then check nvidia-smi
sudo reboot
nvidia-smi

# Install NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit.gpg

echo "deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit.gpg] \
https://nvidia.github.io/libnvidia-container/stable/deb/amd64 /" | \
sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt update
sudo apt install -y nvidia-container-toolkit

# Setup Docker runtime
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Check if Docker can find GPU
docker run --rm --gpus all \
nvidia/cuda:12.3.0-base-ubuntu22.04 \
nvidia-smi
```

Fill torch version and CUDA version in in configs/hw_settings.py for models
```
from types import SimpleNamespace
MASTER_SERVER_CONFIG = SimpleNamespace(
)

TORCH_CONFIG = SimpleNamespace(
    TORCH_VERSION="2.9.1",  # https://pytorch.org/get-started/previous-versions/
    TORCH_CUDA_TAG="cu126",   # cpu | cu121 | cu124 | etc. You can find out the cuda version of your machine 
                            # using nvcc --version or nvidia-smi. Choose "cpu" if you are not using cuda
    HF_HOME="/app/.cache/huggingface"  # Path to huggingface cache dir.
)

EMBEDDER_CONFIG = SimpleNamespace(
    PORT=8000,
    DEVICE="CUDA",           # CPU, CUDA, MPS
)

VLM_CONFIG = SimpleNamespace(
    PORT=8001,
    DEVICE="CUDA",           # CPU, CUDA, MPS
    MODEL_NAME="HuggingFaceTB/SmolVLM-256M-Instruct"
)

```

Build containers with GPUs
```
cd docker/
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```