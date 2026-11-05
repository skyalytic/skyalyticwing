---
name: docker
description: "🐳 Docker管理 - 容器、镜像和Compose编排"
emoji: 🐳
---

# Docker Skill

管理 Docker 容器、镜像和 Docker Compose 编排，实现容器化应用的部署和运维。

## 使用场景

- 容器生命周期管理（创建、启动、停止、删除）
- 镜像管理（拉取、构建、推送）
- Docker Compose 编排
- 日志查看和调试
- 网络和卷管理

## 前置要求

- 需要安装 Docker（`winget install Docker.DockerDesktop` / `apt install docker.io` / `brew install docker`）

## 操作步骤

1. **容器管理**
   ```bash
   docker ps                          # 运行中的容器
   docker ps -a                       # 所有容器
   docker run -d --name myapp -p 8080:80 nginx  # 运行容器
   docker stop myapp                  # 停止容器
   docker rm myapp                    # 删除容器
   docker logs myapp                  # 查看日志
   docker exec -it myapp bash         # 进入容器
   ```

2. **镜像管理**
   ```bash
   docker images                      # 列出镜像
   docker pull nginx:latest           # 拉取镜像
   docker build -t myapp:1.0 .        # 构建镜像
   docker rmi nginx:latest            # 删除镜像
   ```

3. **Docker Compose**
   ```bash
   docker-compose up -d               # 启动服务
   docker-compose down                # 停止服务
   docker-compose logs -f             # 查看日志
   docker-compose ps                  # 服务状态
   docker-compose restart             # 重启服务
   ```

4. **网络和卷**
   ```bash
   docker network ls                  # 列出网络
   docker volume ls                   # 列出卷
   docker system df                   # 磁盘使用
   docker system prune                # 清理资源
   ```

## 示例

```
用户: 列出所有运行中的Docker容器
执行: bash({ command: "docker ps" })

用户: 启动一个nginx容器
执行: bash({ command: "docker run -d --name nginx -p 8080:80 nginx:latest" })

用户: 用docker-compose启动项目
执行: bash({ command: "docker-compose up -d" })

用户: 查看容器日志
执行: bash({ command: "docker logs --tail 100 myapp" })
```
