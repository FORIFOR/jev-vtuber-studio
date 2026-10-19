# YouTube 限定公開テスト（30分）チェックリスト

映像・音声（Stage → OBS → YouTube）と、コメント（YouTube Live Chat → このサーバー）は別の接続。両方を実際に確かめる。アカウント・課金・公開設定は運営者が行う。

## 運営者が行うこと

1. YouTube Studio →「作成 → ライブ配信を開始」→ エンコーダ配信。初回の有効化は最大24時間かかる。
2. 公開範囲 **限定公開**、1920×1080・30fps、遅延 **超低遅延**、チャット有効。自動開始・自動公開はまだ使わない。
3. OBS：Stage（`/stage#token=…`）をブラウザソース1つだけ（音声もこの1系統）。Studio のプレビューは無音。ストリームキーは OBS にだけ入れ、このアプリや AI に渡さない。
4. コメント取得：`node scripts/youtube-auth.mjs` で**配信チャンネルの所有アカウント**で認証（権限は `youtube.readonly` のみ）。Studio の設定で配信の動画 ID を指定。
5. 説明欄の例：
   > AIキャラクターのノアが、自動でゲームとおしゃべりをしています。コメントは選んで返答します。すべてを読み上げるわけではありません。コメントの一部は応答生成のため外部AIサービスで処理されます。個人情報は書き込まないでください。
6. 視聴者層（子ども向けかどうか）は実際の内容どおりに設定する。

**OAuth の期限**：Google Cloud の OAuth 同意画面が「Testing」のままだと、リフレッシュトークンは原則7日で失効する。自動運転の前に公開ステータスを整理する。

## アプリの挙動（確認済みの仕様）

- 動画 ID → `videos.list` → `activeLiveChatId`。配信前は「配信待ち」、終了後は「終了」として扱い、認証失敗とは区別する。
- gRPC `streamList` が既定、使えない場合はポーリング（`pollingIntervalMillis` を守る）。再接続は `nextPageToken` で続きから。
- 番組開始より前のコメント、60秒以上古いコメント、同じメッセージ ID は読まない（再接続でも二重にならない）。
- 返答・読み上げは採用したコメントだけ。「次は速め」などは採用されたコメントからだけ次のラウンドに反映。

## 別端末から投稿して確かめる

「初見です」「何のゲーム？」「次は速め」「かわいい」。同じ文を2回、配信中に接続を切って戻す（再接続）。二重返答・二重演出がないこと、終了時刻・予算処理・音声の停止まで通ること。

## 残す数字（`GET /api/programme/report?transcript=true`）

| 項目 | 場所 |
|---|---|
| 受信コメント数 | `metrics.counters.chat_received` |
| 採用・返答数 | `chat_selected`、`comment_completed` |
| 新規生成した音声・クラウド（ミリ秒、再生されなかった分も含む。従量課金の対象） | `metrics.counters.tts_generated_cloud_ms` |
| 新規生成した音声・ローカル（VOICEVOX / AivisSpeech 等。API 料金なし） | `metrics.counters.tts_generated_local_ms` |
| 句キャッシュから再生した音声（ミリ秒） | `metrics.counters.tts_cache_audio_ms` |
| 推定 TTS 費用・この配信分 | `cloudSpend.session`（USD・音声秒・リクエスト数。番組開始でゼロから） |
| 推定 TTS 費用・日/月の累計（上限はこちらに掛かる） | `cloudSpend.totals` |

`cloudSpend` はアプリ側の見積もりで、Google の請求額ではない（`basis: app_estimate_not_invoice`）。番組を止めると、その配信のカウンターと `cloudSpend.session` がショーログ（`show_stop`）に保存される。

月額の推計 ＝ 試験の `cloudSpend.session.usd` × 予定する月間配信時間 ÷ 試験の配信時間（同じ発話密度を仮定）。例：Flash-Lite で新規音声1分 ≈ $0.009（2026年内の標準料金、2027年1月から倍の予定）。ローカルの声を採用した場合、音声の API 料金は 0 で、`tts_generated_local_ms` は負荷の目安として見る。
