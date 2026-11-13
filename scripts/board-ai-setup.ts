/** Install only official, pinned CPU engines/networks inside the project. No global packages. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, copyFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BOARD_AI_ROOT, NativeBoardAiPolicy, type BoardAiManifest, type BoardEngine } from '../server/bots/boardAi'

const root=BOARD_AI_ROOT, downloads=join(root,'downloads')
mkdirSync(downloads,{recursive:true})
const only=process.argv.find(a=>a.startsWith('--engine='))?.split('=')[1]
const requested:BoardEngine[]=only?[only as BoardEngine]:['stockfish','fairy','pikafish']
if(requested.some(key=>!['stockfish','fairy','pikafish'].includes(key)))throw new Error('--engine 支持 stockfish、fairy 或 pikafish')
if(!['darwin','linux'].includes(process.platform)||!['arm64','x64'].includes(process.arch))throw new Error('自动安装目前支持 macOS 和 Linux 的 arm64/x64；其他平台请配置 .board-ai/manifest.json')
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
function run(command:string,args:string[],cwd?:string) { const r=spawnSync(command,args,{cwd,stdio:'inherit'});if(r.status!==0)throw new Error(`${command} 执行失败${r.error?`: ${r.error.message}`:''}`) }
function download(url:string,name:string,sha?:string) {
  const path=join(downloads,name)
  if(!existsSync(path)||sha&&hash(path)!==sha){const temp=`${path}.part`;run('curl',['-fL','--retry','2','--connect-timeout','15','--max-time','600',url,'-o',temp]);if(sha&&hash(temp)!==sha)throw new Error(`${name} 下载校验失败`);renameSync(temp,path)}
  return path
}
const old=existsSync(join(root,'manifest.json'))?readFileSync(join(root,'manifest.json'),'utf8'):null
const manifest:BoardAiManifest=old?JSON.parse(old):{version:1,platform:process.platform,arch:process.arch,engines:{}}
if(manifest.platform!==process.platform||manifest.arch!==process.arch)throw new Error('当前目录是其他系统的引擎，请为 BOARD_AI_DIR 选择新的目录')
const file=(path:string)=>({path:path.slice(root.length+1),sha256:hash(path)})
for(const key of requested) {
  const previous=manifest.engines[key]
  if(previous&&!process.argv.includes('--force')){
    try{if(hash(resolve(root,previous.binary.path))===previous.binary.sha256&&(!previous.network||hash(resolve(root,previous.network.path))===previous.network.sha256)){console.log(`${key} 已安装且校验一致`);continue}}catch{}
  }
  if(key==='stockfish'){
    const tag='sf_19',asset=process.platform==='darwin'?'stockfish-macos-universal.tar.gz':`stockfish-linux-${process.arch==='arm64'?'arm64':'x86-64'}-universal.tar.gz`
    const expected=process.platform==='darwin'?'a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77':process.arch==='arm64'?'fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01':'9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f'
    const source=`https://github.com/official-stockfish/Stockfish/releases/download/${tag}/${asset}`,archive=download(source,asset,expected),directory=join(root,`stockfish-${tag}`)
    mkdirSync(directory,{recursive:true});run('tar',['-xzf',archive,'-C',directory])
    const binary=join(directory,'stockfish',asset.replace('.tar.gz',''));chmodSync(binary,0o755)
    manifest.engines.stockfish={binary:file(binary),source,revision:tag}
  } else if(key==='fairy'){
    const commit='9f778da667f6e07dae1e85d3e2ea204fc6dee94d',source=`https://codeload.github.com/fairy-stockfish/Fairy-Stockfish/tar.gz/${commit}`
    const archive=download(source,'fairy-source.tar.gz','80f1e20cb680ad83cf38ed22858311ce913c41dadc9adb57178fb25300217132'),directory=join(root,'fairy-source')
    mkdirSync(directory,{recursive:true});run('tar',['-xzf',archive,'-C',directory,'--strip-components=1'])
    const arch=process.arch==='arm64'?process.platform==='darwin'?'apple-silicon':'armv8':'x86-64'
    run('make',['-j2','build',`ARCH=${arch}`,'COMP=clang','largeboards=yes','nnue=no'],join(directory,'src'))
    const binary=join(root,'fairy-stockfish');copyFileSync(join(directory,'src/stockfish'),binary);chmodSync(binary,0o755)
    const net=download('https://drive.usercontent.google.com/download?id=18-zDt7z4H9_IQVvcWIvndnKjC5LZhAfm&export=download&confirm=t','xiangqi-c07e94a5c7cb.nnue','c07e94a5c7cbeae443ed79a8fa412875d833a7f8e04333815e39729c59d52e11')
    // nnue=no disables embedding only; the compiled engine loads the external NNUE via EvalFile.
    manifest.engines.fairy={binary:file(binary),network:file(net),source,revision:commit}
  } else {
    if(process.platform==='linux'&&process.arch==='arm64')throw new Error('这份皮卡鱼发行包没有 Linux ARM64 二进制，请本机编译后登记 manifest；其他引擎可用 --engine 单独安装')
    const revision='Pikafish-2026-09-06',source=`https://github.com/official-pikafish/Pikafish/releases/download/${revision}/Pikafish.2026-09-06.7z`
    const archive=download(source,'Pikafish.2026-09-06.7z','41952bbfe2520faceb5902c69e6ab4845cc999841d2b49a95cc1be7867a25e5b'),directory=join(root,revision)
    mkdirSync(directory,{recursive:true})
    if(process.platform==='darwin')run('bsdtar',['-xf',archive,'-C',directory])
    else if(spawnSync('bsdtar',['--version'],{stdio:'ignore'}).status===0)run('bsdtar',['-xf',archive,'-C',directory])
    else run('7z',['x','-y',`-o${directory}`,archive])
    const binary=join(directory,process.platform==='darwin'?'Pikafish-MacOS-universal':'Pikafish-Linux-x86-64-universal');chmodSync(binary,0o755)
    manifest.engines.pikafish={binary:file(binary),network:file(join(directory,'pikafish.nnue')),source,revision}
  }
}
const temp=join(root,'manifest.json.tmp');writeFileSync(temp,JSON.stringify(manifest,null,2)+'\n');renameSync(temp,join(root,'manifest.json'))
const policy=new NativeBoardAiPolicy(root);await policy.initialize()
let failed=false
for(const key of requested){const status=policy.availability(key==='stockfish'?'chess':'xiangqi',key==='pikafish'?'challenge':'beginner');console.log(`${key}: ${status.available?'PASS':status.message}`);if(!status.available)failed=true}
if(failed){console.error('部分引擎未通过实际启动/NNUE 搜索检查；对应难度会保持不可用。');process.exitCode=1}
else console.log('棋类 AI 安装完成。重启服务后启用五档难度。')
