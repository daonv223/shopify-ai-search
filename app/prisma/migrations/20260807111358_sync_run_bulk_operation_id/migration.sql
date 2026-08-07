-- AlterTable
ALTER TABLE "SyncRun" ADD COLUMN     "bulkOperationId" TEXT;

-- CreateIndex
CREATE INDEX "SyncRun_bulkOperationId_idx" ON "SyncRun"("bulkOperationId");
