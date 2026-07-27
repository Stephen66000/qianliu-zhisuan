-- 仟流智算 PostgreSQL 初始化脚本（容器首次启动时执行）
-- W01 仅占位；业务表由 packages/database 的 Kysely 迁移文件按版本管理。
-- 此文件保留用于未来初始化数据库扩展/扩展插件（如 pgcrypto）。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
