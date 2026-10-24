// soup-view 宿主半边。
//
// 它本身不做任何事：汤底的封存与取回全在 ~/.dsh/tools.js 的 soup 工具里。这个包
// 存在的唯一理由是它的客户端半边需要一个 package.json 才能被 dsh-client-modules
// 定位（clientExportOf 读 exports["./client"]）。
export const name = 'dsh-plugin-soup-view'
export const inject = []

export function apply() {}
