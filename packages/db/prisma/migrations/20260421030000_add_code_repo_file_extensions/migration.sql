-- AlterTable
ALTER TABLE "code_repos" ADD COLUMN "file_extensions" TEXT[] DEFAULT ARRAY[]::TEXT[];
