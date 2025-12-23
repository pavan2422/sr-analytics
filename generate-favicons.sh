#!/bin/bash

# Script to generate favicon files from a source image
# Usage: ./generate-favicons.sh <source-image.png>

SOURCE_IMAGE="$1"

if [ -z "$SOURCE_IMAGE" ]; then
    echo "Usage: ./generate-favicons.sh <source-image.png>"
    echo "Example: ./generate-favicons.sh public/logo.png"
    exit 1
fi

if [ ! -f "$SOURCE_IMAGE" ]; then
    echo "Error: Source image not found: $SOURCE_IMAGE"
    exit 1
fi

echo "Generating favicon files from: $SOURCE_IMAGE"

# Generate favicon.ico (32x32)
sips -s format ico -z 32 32 "$SOURCE_IMAGE" --out public/favicon.ico

# Generate favicon.png (32x32)
sips -s format png -z 32 32 "$SOURCE_IMAGE" --out public/favicon.png

# Generate site-icon.png (512x512)
sips -s format png -z 512 512 "$SOURCE_IMAGE" --out public/site-icon.png

# Generate apple-touch-icon.png (180x180)
sips -s format png -z 180 180 "$SOURCE_IMAGE" --out public/apple-touch-icon.png

# Generate android-chrome-192x192.png (192x192)
sips -s format png -z 192 192 "$SOURCE_IMAGE" --out public/android-chrome-192x192.png

echo "✅ All favicon files generated successfully in public/ directory!"

