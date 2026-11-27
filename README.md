# Hermes Web

远端会话客户端。不包含 iOS 的本机工作台、项目、消息库和定时任务。

静态运行包发布在本仓库 `workbench-runtime` 分支根目录。从私有工作台打开时，服务必须是 HTTPS，并允许对应工作台来源（CORS）；局域网 HTTP 仍用本机代理。

## 本机运行

```sh
python3 web/serve.py
```

浏览器打开 http://127.0.0.1:8787/ 。填写 Hermes API 地址和密钥。

## 检查

```sh
python3 web/protocol_test.py
```
