# 为 Unity Editor MCP 做贡献

感谢你对 Unity Editor MCP 的关注！本文档提供了为该项目做贡献的指南与说明。

## 开始之前

1. Fork 本仓库
2. 克隆你的 fork：`git clone https://github.com/YOUR_USERNAME/unity-editor-mcp.git`
3. 创建新分支：`git checkout -b feature/your-feature-name`

## 开发环境搭建

### 前置要求

- Unity 2020.3 LTS 或更高
- Node.js 18.0.0 或更高
- Git

### 搭建步骤

1. 在 mcp-server 目录安装依赖：
   ```bash
   cd mcp-server
   npm install
   ```

2. 在你的 Unity 项目中安装 Unity 包（见 README.md）

3. 运行测试：
   ```bash
   npm test
   ```

## 代码规范

### TypeScript/JavaScript

- 使用 ES6+ 特性
- 遵循现有代码风格
- 为公共函数添加 JSDoc 注释
- 保持函数聚焦、职责单一

### Unity C#

- 遵循 Unity 编码约定
- 使用有意义的变量和方法名
- 为公共方法添加 XML 文档注释
- 妥善处理异常

### 提交信息

- 使用清晰、描述性的提交信息
- 以现在时动词开头（如 "Add"、"Fix"、"Update"）
- 首行保持在 50 字符以内
- 如有需要可添加详细描述

示例：
```
Add GameObject search by component type

- Implement find_by_component tool
- Add support for exact type matching
- Include inactive object filtering
```

## 测试

- 为新特性编写测试
- 提交 PR 前确保所有测试通过
- 同时测试 Node.js 和 Unity 组件
- 适当时包含集成测试

## Pull Request 流程

1. 必要时更新文档
2. 确保所有测试通过
3. 如果新增了工具，更新 README.md
4. 提交带清晰描述的 PR
5. 及时响应评审反馈

## 报告问题

- 使用 GitHub Issues 报告 bug 和功能请求
- 包含 Unity 版本和操作系统信息
- 为 bug 提供复现步骤
- 包含相关错误信息和日志

## 行为准则

- 尊重并包容他人
- 欢迎新手并帮助他们入门
- 注重建设性反馈
- 开放透明地协作

## 有问题？

如有任何关于贡献的问题，欢迎开启 issue 提问！
