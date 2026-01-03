# How 2GB File Upload Works

## Overview

The application uses a **chunked/resumable upload system** designed to handle large files (up to several GB) efficiently without running into browser memory limits or server timeouts.

## Upload Process Flow

### 1. **Initialization** (`/api/uploads/init`)
- Client sends file metadata (name, size, content type)
- Client specifies chunk size (default: **16MB**, configurable 1MB-128MB)
- Server creates an upload session in the database
- Server returns `uploadId` and `expectedParts` (number of chunks)

**For a 2GB file with 16MB chunks:**
- Expected parts: `2,048 MB ÷ 16 MB = 128 chunks`

### 2. **Chunked Upload** (`/api/uploads/[uploadId]/part/[partNumber]`)
- Client splits the file into chunks (using `File.slice()`)
- Each chunk is uploaded separately via PUT request
- Chunks are stored as temporary files on disk: `data/uploads/tmp/[uploadId]/part-[number].bin`
- Server tracks progress in database (`receivedBytes`)
- **Idempotent**: If a chunk already exists with correct size, it's skipped (resume support)

**Key Features:**
- ✅ **Streaming**: Uses Node.js streams (`pipeline`) - no full file in memory
- ✅ **Resumable**: Can resume from any point if upload fails
- ✅ **Progress Tracking**: Real-time progress updates
- ✅ **Error Recovery**: Failed chunks can be retried individually

### 3. **Finalization** (`/api/uploads/[uploadId]/complete`)
- Client signals all chunks are uploaded
- Server verifies all parts are received
- Server streams chunks sequentially to create final file
- Computes SHA256 hash during assembly (streaming)
- Stores final file at: `data/uploads/files/[storedFileId]-[filename]`
- Cleans up temporary chunk files
- Updates database with completion status

## Memory Efficiency

### Server-Side
- **No full file buffering**: Uses Node.js streams (`fs.createReadStream`, `fs.createWriteStream`)
- **Chunk-based processing**: Each chunk is processed independently
- **Streaming hash**: SHA256 computed incrementally during file assembly
- **Disk storage**: Files stored on disk, not in database (only metadata in DB)

### Client-Side
- **File.slice()**: Browser's native file slicing (no memory copy)
- **Chunked uploads**: Only one chunk (16MB) in memory at a time
- **Progress tracking**: Real-time progress updates without blocking

## File Size Limits

### Current Configuration
- **Chunk size**: 1MB - 128MB (default: 16MB)
- **Maximum file size**: No hard limit, but practical limits apply:
  - **Browser memory**: ~4GB practical limit
  - **Disk space**: Limited by server storage
  - **Network**: Depends on connection stability

### Recommended Chunk Sizes
- **Small files (<50MB)**: 16MB chunks
- **Large files (50MB-500MB)**: 16MB chunks
- **Very large files (500MB-2GB)**: 16-32MB chunks
- **Ultra-large files (2GB+)**: 32-64MB chunks (fewer requests)

## Processing After Upload

### For CSV Files (>50MB)
1. **Backend Upload Path**: File uploaded to server
2. **Server-side Processing**: 
   - File processed in chunks using streaming
   - Analysis runs on server (avoids browser memory limits)
   - Results stored in database
3. **Client receives**: Analysis results, not raw data

### For Smaller Files (<50MB)
1. **Client-side Processing**: 
   - File parsed in browser using PapaParse (streaming)
   - Data normalized in Web Workers (background threads)
   - Stored in IndexedDB in batches (50k rows at a time)
2. **Analysis**: Runs in browser with progress updates

### For Ultra-Large Files (>1.5GB)
- **Bounded Sample Mode**: Automatically samples data to avoid crashes
- **Backend Processing**: Always uses server-side processing

## Example: 2GB File Upload

```
File: transactions.csv (2,048 MB)

Step 1: Initialize
  → POST /api/uploads/init
  → Returns: uploadId="abc-123", expectedParts=128

Step 2: Upload Chunks (128 requests)
  → PUT /api/uploads/abc-123/part/1  (16MB)
  → PUT /api/uploads/abc-123/part/2  (16MB)
  → PUT /api/uploads/abc-123/part/3  (16MB)
  → ... (125 more chunks)
  → PUT /api/uploads/abc-123/part/128 (16MB)

Step 3: Finalize
  → POST /api/uploads/abc-123/complete
  → Server assembles: part-1.bin + part-2.bin + ... + part-128.bin
  → Final file: data/uploads/files/[id]-transactions.csv
  → Returns: storedFileId, sha256Hex

Step 4: Analysis
  → POST /api/uploads/abc-123/analysis
  → Server processes file in streaming chunks
  → Results stored in database
```

## Performance Characteristics

### Upload Speed
- **Network dependent**: Limited by your internet connection
- **Parallel uploads**: Currently sequential (one chunk at a time)
- **Resume capability**: Can pause and resume without losing progress

### Processing Speed
- **CSV Streaming**: ~100k-500k rows/second (depends on data complexity)
- **Excel**: Slower (~10k-50k rows/second) - must load full file first
- **Large files (2GB)**: May take 10-30 minutes to process

### Memory Usage
- **Server**: ~50-100MB (only active chunk in memory)
- **Client**: ~16MB (one chunk at a time)
- **Database**: Only metadata (file info, analysis results)

## Error Handling & Recovery

### Upload Failures
- **Network errors**: Chunk uploads can be retried individually
- **Resume support**: Upload session persists, can resume later
- **Partial uploads**: Server keeps received chunks until completion or cleanup

### Processing Failures
- **Validation errors**: Invalid data rows are skipped, logged
- **Memory errors**: Large files automatically use backend processing
- **Timeout protection**: Chunked processing prevents timeouts

## Storage Location

### Temporary Chunks
- Path: `data/uploads/tmp/[uploadId]/part-[number].bin`
- Cleaned up: After successful completion

### Final Files
- Path: `data/uploads/files/[storedFileId]-[filename]`
- Persisted: Until manually deleted
- Database: Only metadata stored (not file content)

## Best Practices for 2GB Files

1. **Use CSV format**: Better streaming support than Excel
2. **Stable connection**: Large uploads benefit from reliable network
3. **Monitor progress**: UI shows real-time upload/processing progress
4. **Be patient**: 2GB files may take 20-40 minutes total (upload + processing)
5. **Check disk space**: Ensure server has enough storage

## Technical Details

### Chunk Size Calculation
```javascript
chunkSizeBytes = 16 * 1024 * 1024; // 16MB default
expectedParts = Math.ceil(fileSize / chunkSizeBytes);
```

### Stream Assembly
```javascript
// Server streams chunks sequentially to final file
for (let part = 1; part <= expectedParts; part++) {
  const partStream = fs.createReadStream(partPath);
  const finalStream = fs.createWriteStream(finalPath, { flags: 'a' });
  await pipeline(partStream, hashTransform, finalStream);
}
```

### Progress Tracking
- Upload: 0-90% (chunk uploads)
- Processing: 90-100% (server-side analysis)

