# 游戏注册表

`shared/gameCatalog.ts` 提供 `GAME_KINDS` 和 `GAME_DEFINITIONS`。列表决定大厅内各分类的展示顺序，目录记录棋类或牌类、默认座位数、牌副数、简介和支持的开房模式。`isGameKind` 供开房、教程 WebSocket、会话恢复和本地战绩读取校验游戏类型。

登记游戏时，在 `shared/protocol.ts` 扩展 `GameKind` 和相关快照及指令，在共享目录补齐列表与目录项，再在 `server/room.ts` 登记引擎工厂和默认手机座位布局。牌类工厂接收房间创建的 `GameContext`，两座游戏可以复用 `TWO_SEATS`，房间会复制其中的坐标。军棋的目录座位数对应默认双人局，四国布局由房间切换模式时设置。

首页卡片说明放在 `src/gamePresentation.ts`，各游戏规则正文在 `src/components/GameRules.vue` 登记。规则页签沿用目录顺序，并把国际象棋放在中国象棋之后，方便查阅两款象棋的规则。

`tests/gameCatalog.test.ts` 校验目录、游戏类型、卡片说明与页签，逐款通过 `Room` 构造入口检查实际引擎和默认手机座位，并验证本地战绩读取、共享布局复制。运行 `npm test` 和 `npm run build` 检查完整测试与类型。
