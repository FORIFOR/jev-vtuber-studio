# dependency-map/group-1/n-src-util-mjs-255449

[解析トップへ戻る](../../../README.md)

確認済みファイル: `src/util.mjs`

解析: 字句抽出。静的なimport／export参照です。関数の実行順序やHTTP通信は表していません。

宣言: `assertText`, `boundedBody`, `request`, `safeWebURL`

- `node:crypto` → 外部・標準ライブラリ・別名など。ローカル対応先は未確定


```mermaid
graph TD
    source["ソース\nsrc/util.mjs"]
    n-node-crypto-c7dfc5["node:crypto\n外部・別名・未解決"]
    source -->|"字句抽出: import／export"| n-node-crypto-c7dfc5
```

## 要素の説明

### n-node-crypto-c7dfc5

参照名: `node:crypto`

ローカルのソース対応先を確定できませんでした。外部ライブラリ、標準ライブラリ、型別名などを区別する追加確認が必要です。

### source

`src/util.mjs` の内容を確認しました。

