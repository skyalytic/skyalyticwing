---
name: database
description: "🗄️ 数据库操作 - 查询、管理和维护多种数据库"
emoji: 🗄️
---

# Database Skill

连接、查询和管理多种数据库系统，包括SQLite、MySQL、PostgreSQL、MongoDB等。

## 使用场景

- 执行SQL查询和数据操作
- 数据库备份和恢复
- 表结构管理和迁移
- 数据导入导出
- 性能优化建议

## 操作步骤

1. **SQLite 操作**（内置支持）
   - 使用 `bash` 执行 `sqlite3` 命令
   - 或使用 `code_execution` 执行 Python sqlite3 模块

2. **MySQL/PostgreSQL 操作**
   - 使用 `bash` 执行 `mysql` 或 `psql` 命令
   - 需要预配置连接信息（环境变量或配置文件）

3. **MongoDB 操作**
   - 使用 `bash` 执行 `mongosh` 命令
   - 或使用 Python pymongo 模块

4. **通用操作**
   - 查询: SELECT / find()
   - 插入: INSERT / insertOne/Many()
   - 更新: UPDATE / updateOne/Many()
   - 删除: DELETE / deleteOne/Many()
   - 结构: CREATE/ALTER/DROP

## 安全注意事项

- 永远不要在命令中直接暴露密码
- 使用环境变量存储连接信息
- 对用户输入进行参数化查询，防止SQL注入
- 危险操作（DROP、TRUNCATE）需要确认

## 示例

```
用户: 查询SQLite数据库中的所有用户
执行: bash({ command: "sqlite3 /path/to/db.sqlite 'SELECT * FROM users LIMIT 100;'" })

用户: 备份MySQL数据库
执行: bash({ command: "mysqldump -u $DB_USER -p$DB_PASS -h $DB_HOST $DB_NAME > backup.sql" })

用户: 在PostgreSQL中创建新表
执行: bash({ command: "psql -h $PG_HOST -U $PG_USER -d $PG_DB -c 'CREATE TABLE ...'" })
```
