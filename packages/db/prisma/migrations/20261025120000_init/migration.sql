-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "headCommit" TEXT,
    "language" TEXT,
    "packageManager" TEXT,
    "testFramework" TEXT,
    "detection" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "baseCommit" TEXT,
    "branch" TEXT,
    "worktreePath" TEXT,
    "plan" JSONB,
    "checkpoint" JSONB,
    "verification" JSONB,
    "usage" JSONB,
    "budget" JSONB NOT NULL,
    "error" TEXT,
    "errorCode" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "runnerId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "sandboxMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStep" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "resolution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Repository_rootPath_key" ON "Repository"("rootPath");

-- CreateIndex
CREATE INDEX "Task_repositoryId_createdAt_idx" ON "Task"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_status_heartbeatAt_idx" ON "Task"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "AgentStep_taskId_sequence_idx" ON "AgentStep"("taskId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_taskId_sequence_key" ON "AgentStep"("taskId", "sequence");

-- CreateIndex
CREATE INDEX "Approval_taskId_status_idx" ON "Approval"("taskId", "status");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

