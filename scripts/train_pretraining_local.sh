#!/bin/bash
set -x

# Get the absolute path to the project root
PROJECT_ROOT=$(pwd)
echo "Project Root: $PROJECT_ROOT"

# Set environment variables
export PYTHONPATH=$PROJECT_ROOT:$PYTHONPATH
export WANDB_MODE=disabled

# Configuration
data_path=$PROJECT_ROOT/data
SAVE_MODEL_NAME=clara_local_stage1
SAVE_PATH=$PROJECT_ROOT/checkpoints/$SAVE_MODEL_NAME
MODEL_PATH=TinyLlama/TinyLlama-1.1B-Chat-v1.0  # Use TinyLlama for accessible local training

mkdir -p $SAVE_PATH

# Local settings
NUM_LOCAL_GPUS=1

echo "Starting Local Training..."

# Training command
# Removed --flash_attn for Mac compatibility
# reduced batch sizes for memory
training_commands="openrlhf.cli.train_sft \
   --max_len 512 \
   --dataset $data_path/pretrain_data.jsonl \
   --pretrain $MODEL_PATH \
   --train_batch_size 1 \
   --micro_train_batch_size 1 \
   --ckpt_path $SAVE_PATH \
   --max_samples 10 \
   --save_path $SAVE_PATH \
   --save_steps -1 \
   --logging_steps 1 \
   --eval_steps -1 \
   --zero_stage 0 \
   --max_epochs 1 \
   --bf16 \
   --learning_rate 1e-4 \
   --stage stage1 \
   --generation_top_k 1 \
   --qa_loss \
   --doc_max_length 256 \
   --compress_rate 4 \
   --mse_loss \
   --gradient_checkpointing"

# Run with python directly for simplicity on local single device (or MPS)
# Note: DeepSpeed might complain on Mac without specific setup, falling back to standard if needed?
# Actually, the original script uses openrlhf.cli.train_sft which uses DeepSpeed. 
# We will try to run it. If strict DeepSpeed is required, this might fail on Mac without chaotic config.
# We will assume 'accelerate' or 'torchrun' handles it best.
# Let's use torchrun with 1 proc.

torchrun --nproc_per_node=1 -m $training_commands

echo "Training completed!"
