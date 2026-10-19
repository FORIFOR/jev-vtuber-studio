# rc.4 変更内容

対象：この会話のrc.3ソースZIP。公開GitHubへpushしていません。

| 境界 | 変更 |
|---|---|
| src/voice-routing.mjs | 独立したCommentVoice（VOICEVOX）・Supertonic3アダプター・選択式ReplyVoice |
| src/talk-engine.mjs | コメント音声と回答生成の並行処理。単一送出キューでコメント→本回答。取消と所有権の継承 |
| src/engine.mjs | readAllowed保存、speaker role、読み上げの発言記憶除外 |
| src/jev.mjs | 採用と別の引用安全性質問を同じリクエストに追加 |
| src/providers.mjs | 読み上げ済みコメントを復唱せず直接答える指示 |
| src/settings.mjs / server.mjs | 独立した声設定、二音声試聴、両方の聴取ゲート、試聴音声の管理者限定配布 |
| public/ | 話者ラベル、コメント中の口パク抑制、設定、分離した遅延表示 |
| scripts/supertonic-local.py | 固定アーカイブ明示取得、auto_download=False、公式サーバーloopback起動 |
| test/comment*.test.mjs | 30件の追加回帰・HTTP統合・実タイマー試験 |
| test/supertonic-launcher.py | 模擬SDKによる3件の起動配線試験 |

旧140件は読み上げOFFを明示した既存経路で維持し、新30件で読み上げONを検証します。型・引用可否が欠けた模擬Jev応答を勝手に許可扱いへ変えず、追加のnoulが必要なことを検査します。

デフォルトはコメント読み上げON、既存ホストVOICEVOXを維持。Supertonicを選ぶまでは推論サーバーや声を勝手に変更しません。設定移行は[UPGRADE.md](UPGRADE.md)、使い方と未検証境界は[COMMENT_REPLY.md](COMMENT_REPLY.md)に記載しています。
