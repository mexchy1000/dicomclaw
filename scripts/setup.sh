#!/bin/bash
# DICOMclaw setup script

set -e

echo "=== DICOMclaw Setup ==="

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required. Install from https://nodejs.org/"
    exit 1
fi
echo "Node.js: $(node --version)"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required."
    exit 1
fi
echo "Python: $(python3 --version)"

# Install Node.js dependencies
echo ""
echo "Installing Node.js dependencies..."
npm install

echo ""
echo "Installing web-ui dependencies..."
cd web-ui && npm install && cd ..

# Install Python dependencies
echo ""
echo "Installing Python dependencies..."
pip install pydicom nibabel numpy scipy matplotlib Pillow requests

# Optional heavy dependencies
echo ""
echo "Optional: Install TotalSegmentator and nnUNet for organ/lesion analysis"
echo "  pip install TotalSegmentator"
echo "  pip install nnunetv2"

# Create directories
echo ""
echo "Creating data directories..."
mkdir -p data/studies results weights logs

# Setup .env
if [ ! -f .env ]; then
    echo ""
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "Please edit .env to set your OPENROUTER_API_KEY"
fi

# Build
echo ""
echo "Building backend..."
npm run build

echo ""
echo "Building frontend..."
npm run build:ui

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start: npm start"
echo "Then open: http://localhost:8411"
echo ""
echo "Place DICOM data in data/studies/ and the indexer will scan on startup."
