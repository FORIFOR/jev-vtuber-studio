# dependency-map/group-1/n-src-remote-control-mjs-d611c4

[解析トップへ戻る](../../../README.md)

確認済みファイル: `src/remote-control.mjs`

解析: 字句抽出。静的なimport／export参照です。関数の実行順序やHTTP通信は表していません。

宣言: `RemoteError`, `RemoteControl`

- `node:crypto` → 外部・標準ライブラリ・別名など。ローカル対応先は未確定
- `./util.mjs` → `src/util.mjs`（内容確認済み）


```mermaid
graph TD
    source["ソース\nsrc/remote-control.mjs"]
    n-node-crypto-c7dfc5["node:crypto\n外部・別名・未解決"]
    source -->|"字句抽出: import／export"| n-node-crypto-c7dfc5
    n-util-mjs-c035dc["./util.mjs\nsrc/util.mjs"]
    source -->|"字句抽出: import／export"| n-util-mjs-c035dc
```

## 要素の説明

### n-node-crypto-c7dfc5

参照名: `node:crypto`

ローカルのソース対応先を確定できませんでした。外部ライブラリ、標準ライブラリ、型別名などを区別する追加確認が必要です。

### n-util-mjs-c035dc

参照名: `./util.mjs`

対応する実在ソース: `src/util.mjs`。内容確認済み。

### source

`src/remote-control.mjs` の内容を確認しました。

