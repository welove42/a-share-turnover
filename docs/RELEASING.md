# 自动打包与发布

**只有用户明确要求打 Tag 时才创建标签，包括大版本。** 日常更新只提交源码、更新说明并按需打包。推送 `v版本号` 标签即可自动测试、打包并上传 VS Code 插件市场。普通提交不会发布，也不会自动生成标签。

**发布版本必须连续。** 打 Tag 前核对远程最新发布 Tag 和市场已发布版本，默认只增加一个补丁号，例如 `1.28.1 → 1.28.2`，不能直接发布 `1.28.5`。只有用户明确要求时才升级主版本或次版本。日常开发只写“待发布”，不提前递增正式版本号；发布时合并这段时间的更新，并统一修改版本号。历史未发布的开发版本不补打 Tag，已有 Tag 不移动、不重打。

## 首次配置一次

打开 [Marketplace 发布者后台](https://marketplace.visualstudio.com/manage/publishers/welove42)，选择 **Trusted Publishing（可信发布）→ Create**，填写：

| 项目 | 填写内容 |
| --- | --- |
| Policy name | `a-share-turnover release` |
| Repository owner | `welove42` |
| Repository | `a-share-turnover` |
| Workflow | `publish.yml` |
| Environment | 留空 |

保存即可。不需要创建 PAT，也不需要在 GitHub Secrets 中填写 Token。未完成这一步时，流水线可以打包，但上传市场会失败。

方式来自 [微软可信发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)。

## 用户要求发布时

1. 根据上一发布版确定下一连续版本，更新 `package.json`、`package-lock.json` 中的版本号，以及 `package.json` 的打包文件名。
2. 将 `CHANGELOG.md` 的“待发布”内容整理为对应版本的更新说明，例如上一版为 `1.28.1`，本次写 `## 1.28.2`。
   图标文件须不超过1024 KB；本地构建和流水线会提前检查，避免打包成功后上传失败。
3. 提交并推送代码。确认本次已明确要求打 Tag 后，再创建同名版本标签：

```sh
git tag v1.28.2
git push origin v1.28.2
```

`1.28.2` 只是示例，请替换成核对后的实际版本。标签与 `package.json` 不一致、缺少更新说明或测试失败时，流程会停止，不会上传市场。

推送后等待对应 [Actions 流水线](https://github.com/welove42/a-share-turnover/actions/workflows/publish.yml) 结束，报告成功或失败即可，不再等待插件市场页面显示新版本。流水线成功表示测试、打包和上传步骤通过，不代表已核实市场页面更新。打包成功后，VSIX 会保存在该次运行的 Artifacts 中 90 天；上传市场失败也能下载包手动处理。

## 测试打包和发布授权

在 Actions 中打开 **Package and publish extension → Run workflow**，选择 `main`，保留勾选 **验证 Marketplace 可信发布授权（不上传插件）**，然后运行。

测试、打包以及 **Verify Marketplace trusted publishing (no upload)** 均显示成功，即表示构建正常、GitHub 已能通过可信策略取得市场发布凭证。**Publish to VS Code Marketplace** 显示跳过是正常的；手动测试不上传插件、不修改版本、不创建标签。

尚未配置可信策略时，可以取消勾选，只检查打包。授权验证通过不等于完成实际上传；完整发布仍由下次推送新版本标签触发。

## 常见情况

- **刚创建的 `v1.20.2` 没有触发**：该标签早于流水线配置，且指向的提交没有工作流，不会追溯触发。保留这个标签；下次按下一连续版本发布。
- **可信发布认证失败**：核对发布者、仓库所有者、仓库名和 `publish.yml` 是否一致；Environment 必须留空。
- **市场提示版本已存在**：已发布版本不能重复覆盖。不要移动旧标签；修正内容后使用新的版本号和标签。
- **临时网络或认证失败**：解决原因后，在原来的标签运行中选择 **Re-run failed jobs**；只对尚未成功上传的版本重试。
