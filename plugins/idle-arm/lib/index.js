// idle-arm 宿主半边。
//
// 它本身不做任何事：落盘拦截的规则与武装端点全部在 ~/.dsh/plugins/idle-guard.js
// 里（POST /idle-arm/arm）。这个包存在的唯一理由是它的客户端半边需要一个
// package.json 才能被 dsh-client-modules 定位（clientExportOf 读 exports["./client"]）。
//
// 为什么不把 package.json 放在 ~/.dsh/plugins/ 根：client-modules 的 nearestPackage
// 是从模块路径向上找最近的 package.json，根上的那一份会让同级所有插件都被误认为
// 声明了同一个客户端 bundle。独立子目录把这份声明精确地限制在本插件上。
export const name = 'dsh-plugin-idle-arm'
export const inject = []

export function apply() {}
