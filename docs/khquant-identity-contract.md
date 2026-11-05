# KH Link 与 khQuant 身份及权益接口契约

KH Link 在 khQuant 提供下列官方接口前不得公开上线。当前 `v2/identity` 仅提供严格的接入层：未配置接口时必须明确返回不可用，绝不能回退为 KH Link 自建密码账户。

## 一、OAuth 2.1 与 PKCE

生产环境需要配置：

- `KHQUANT_OIDC_ISSUER`
- `KHQUANT_OIDC_CLIENT_ID`
- `KHQUANT_OIDC_AUTHORIZE_URL`
- `KHQUANT_OIDC_TOKEN_URL`
- `KHQUANT_OIDC_PROFILE_URL`
- `KHQUANT_OIDC_ENTITLEMENT_URL`

授权采用 `response_type=code`、`code_challenge_method=S256`、一次性随机 `state` 以及本机回环地址或已注册 HTTPS 重定向地址。khQuant 账户密码不得经过 KH Link。令牌接口应采用 khQuant 官方注册客户端认证方式，返回短期访问令牌。KH Link 不得记录授权码、访问令牌、刷新令牌或 PKCE 验证字符串。

## 二、必要的个人资料响应

携带访问令牌请求个人资料时，必须返回稳定的 `sub`、昵称、可选 `picture` 和账户禁用状态。账户变更须通过标准 OAuth 访问令牌校验或签名保护。

## 三、khQuant 权益与事件

权益接口必须返回套餐、到期时间，以及 `active`、`expiring`、`expired`、`payment_pending`、`account_exception` 或 `unavailable` 之一。khQuant 还必须推送经认证的会员变更事件，其中包含唯一事件标识和生效时间。KH Link 的短周期查询仅作为补救措施。

## 四、嵌套的 KH Link 权益

身份统一，权益独立。一个 KH Link `accountId` 下有 `khquant` 与 `kh_link` 两条独立权益记录：

- 有效或即将到期的 khQuant VIP 自动授予 KH Link 权益，不创建重复 KH Link 订单。
- 非 khQuant VIP 用户可以单独购买 KH Link VIP，该权益可以独立提供 KH Link 访问权，不会改变 khQuant 会员状态。
- 两项权益同时有效时，KH Link 会保持可用到最后一项有效权益结束；账户页应分别显示两种来源及各自到期时间。
- 取消、退款、支付处理中或到期仅改变其自身权益。只有至少一项来源处于 `active` 或 `expiring` 时，才允许新的远程写入。

KH Link 单独计费还需要支付服务商接口：签名 Webhook、幂等事件标识、订阅标识、产品与套餐、生效时间、退款/取消状态和客户自助管理地址。支付数据必须保留在支付服务商处，KH Link 只保存订阅引用和权益状态。

## 五、公开上线门槛

面向全体会员开放前，必须验证令牌签名、受众和签发方，授权码重放拦截、令牌撤销、账户禁用、权益事件重放、限流及故障降级行为。已有的旧管理员接口仅作开发兼容，不得出现在公开 KH Link 路由中。
