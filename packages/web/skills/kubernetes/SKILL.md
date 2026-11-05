---
name: kubernetes
description: "☸️ Kubernetes管理 - 集群、Pod、Service和部署管理"
emoji: ☸️
---

# Kubernetes Skill

管理 Kubernetes 集群资源，包括 Pod、Service、Deployment 和 ConfigMap 等。

## 使用场景

- 查看集群状态和资源
- 管理 Pod 生命周期
- 部署和更新应用
- 配置管理
- 日志和调试

## 前置要求

- 需要安装 kubectl（`winget install Kubernetes.kubectl` / `brew install kubectl`）
- 需要配置 kubeconfig 连接到集群

## 操作步骤

1. **集群信息**
   ```bash
   kubectl cluster-info
   kubectl get nodes
   kubectl top nodes
   ```

2. **Pod管理**
   ```bash
   kubectl get pods -A
   kubectl describe pod POD_NAME
   kubectl logs POD_NAME
   kubectl exec -it POD_NAME -- bash
   kubectl delete pod POD_NAME
   ```

3. **部署管理**
   ```bash
   kubectl get deployments
   kubectl rollout status deployment/APP
   kubectl rollout undo deployment/APP
   kubectl scale deployment/APP --replicas=3
   ```

4. **Service和Ingress**
   ```bash
   kubectl get svc
   kubectl get ingress
   kubectl port-forward svc/APP 8080:80
   ```

5. **配置管理**
   ```bash
   kubectl get configmaps
   kubectl get secrets
   kubectl apply -f manifest.yaml
   ```

## 示例

```
用户: 查看所有Pod状态
执行: bash({ command: "kubectl get pods -A" })

用户: 查看某个Pod的日志
执行: bash({ command: "kubectl logs --tail=100 POD_NAME" })

用户: 扩容部署到3个副本
执行: bash({ command: "kubectl scale deployment/myapp --replicas=3" })

用户: 应用新的配置
执行: bash({ command: "kubectl apply -f deployment.yaml" })
```
