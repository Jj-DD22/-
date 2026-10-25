# 换物1.0

人物主图与商品参考图的换物工作台。产品版本为 **换物1.0**，代码版本 **1.0.0**。

## 功能

- 云端整图编辑：上传两张原图，校正方向，整图视觉检查，调用百炼真实图像编辑，保存候选并复核。
- 本地精确抠图与合成：可用时通过本机 ComfyUI 处理；不支持的材质或几何关系会提示复核。
- 结果对照、下载、人工接受或记录需修改；生成完成与人工验收分开记录。
- 共享工作台使用访问码与浏览器会话隔离任务；断线查询原任务，不自动重复付费提交。

## 从源码启动

1. 安装 Node.js 22.18 或更高版本，以及 Python 3.10 或更高版本。
2. 用准备运行服务的 Python 安装 `requirements.txt`。
3. 将 `.env.example` 复制为 `.env`，填写 Python 可执行文件路径和本机数据目录。默认端口为 8780；只在本机使用时保留回环地址即可。
4. 将 `.env.vision.example` 复制为 `.env.vision`，填写视觉服务的 endpoint、model 和 key。当前云端编辑适配阿里云百炼，视觉 endpoint 必须属于支持的百炼地域；实际 Key 的模型权限与地域需要匹配。
5. 云端编辑默认使用 `qwen-image-2.0-pro` 并复用视觉 Key。需要覆盖时参考 `.env.image-edit.example`。密钥只能保存在主机配置中。
6. 执行 `npm start`，打开 `http://127.0.0.1:8780/`。访问码在配置的数据目录下 `access-code.txt`。

云端编辑不要求 ComfyUI 正在运行。本地合成需另行启动 ComfyUI，配置 `SWAP_COMFY_URL`，并准备相应模型和节点。精细分割另需通过校验的 MobileSAM 运行包，以 `SWAP_SEGMENTATION_ROOT` 指定；运行包未安装时会明确拒绝精细抠图。

Windows 既有完整运行包可继续使用 `shared/Start.ps1 -NoBrowser`。该启动器同时检查本地模型与运行环境，可通过 `shared/settings.local.json` 配置；它与纯云端源码启动的依赖要求不同。

## 检查与打包

```powershell
npm test
python -m unittest discover -s tests -p 'test_*.py'
python handoff/build_source.py --output C:/Releases/swap-studio-1.0.0-source.zip
python shared/build_shared.py --output C:/Releases/swap-studio-1.0.0-host-update.zip
```

构建输出必须使用新路径，避免覆盖已有发行包。`release-files.json` 是三个打包入口共用的应用文件清单，新增后端模块必须更新此清单。源码包与主机更新包不包含密钥、素材、历史任务、模型和运行时。`portable/build_package.py` 是本机完整离线包构建入口，需额外准备运行时和模型；不应把其产物上传到源码仓库。

## 发布边界

用户于 2026-10-25 同意将当前开发结果命名为换物1.0。该版本保存当前已验证的前后端能力，不代表所有素材均自动达到商业修图标准。半透明材质、复杂遮挡、镜像与商品细节仍需人工检查；模型可能增加配件或改变发型。模型视觉复核也可能误判，不能代替人工验收。

此仓库发布应用源码和测试；未指定开源许可证，不附带模型或第三方素材的授权。
