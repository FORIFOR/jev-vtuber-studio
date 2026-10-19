# ノアの配信統合（2026-09-30）

Studioの配信先切り替え、Twitchコメント連携、ラウンド終了後の振り返りと雑談、視聴分析、OBS性能監視、macOSメモリ保護をまとめた変更。

ゲーム制御側は [FORIFOR/jev-vampire-survivors](https://github.com/FORIFOR/jev-vampire-survivors) のコミット `cd6d0ba` と組み合わせる。元のMITライセンスと履歴を保持した非公開リポジトリで、アクセス権が必要。ゲーム本体、セーブ、APIキー、配信キー、OAuthトークンは含まない。

- [Twitch接続・同時配信](twitch-chat.md)
- [ライブ・動画・Shortsの分析](audience-analytics.md)
- [フレームレート・OBS性能監視](stream-performance.md)
- [メモリ保護・キャッシュ制限・再開手順](memory-protection.md)

保存済みの本人用設定はGit管理外。別環境では `.env.example` を参考に設定し、声・配信先・コメント接続を確認する。キャッシュ制限のLaunchAgentはひな形であり、Gitから取得するだけではOS設定は変わらない。

検証結果: Studioの `npm run release:check` は535件、ゲーム制御側のオフラインテストは122件成功。実機で残っているWindowServerのメモリ増加、OS再起動後の確認、修正後の長時間同時配信は未検証。テスト成功は3時間配信の安定性を保証するものではない。
