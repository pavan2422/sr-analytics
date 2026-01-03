-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "sha256Hex" TEXT,
    "storageBackend" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "StoredFileAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "totalRows" INTEGER,
    "resultJson" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storedFileId" TEXT NOT NULL,
    CONSTRAINT "StoredFileAnalysis_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "chunkSizeBytes" INTEGER NOT NULL,
    "receivedBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "storedFileId" TEXT,
    CONSTRAINT "UploadSession_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "StoredFile_createdAt_idx" ON "StoredFile"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StoredFileAnalysis_storedFileId_key" ON "StoredFileAnalysis"("storedFileId");

-- CreateIndex
CREATE INDEX "StoredFileAnalysis_status_idx" ON "StoredFileAnalysis"("status");

-- CreateIndex
CREATE INDEX "StoredFileAnalysis_createdAt_idx" ON "StoredFileAnalysis"("createdAt");

-- CreateIndex
CREATE INDEX "UploadSession_status_idx" ON "UploadSession"("status");

-- CreateIndex
CREATE INDEX "UploadSession_createdAt_idx" ON "UploadSession"("createdAt");
