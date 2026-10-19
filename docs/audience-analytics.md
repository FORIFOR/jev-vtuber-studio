# 視聴分析

Studio右上の「視聴分析」から開く。分析用サービスは http://127.0.0.1:8790/ で、このMacだけにバインドする。Studio管理トークンが必要。API・ブラウザのデータはno-store、外部スクリプト不使用。配信エンジンと別プロセスなので集計失敗で配信を止めない。

`AUDIENCE_ANALYTICS=1` を .env に保存すると、通常のStudio起動時に分析サービスも起動する。手動起動は `npm run analytics`。同じポートのプロセスが既にある場合は二重起動せず終了。現在進行中の配信を再起動する必要はない。

## 取得と限界

- ライブは60秒間隔でYouTube Data API videos.liveStreamingDetails.concurrentViewers / Twitch Get Streams.viewer_countを記録。YouTubeの配信枠を5分間隔で探索する。YouTubeが人数を返さない場合は欠損とし、0に置き換えない。
- 過去の観測していない時間は埋めない。人数は累計来場者数・固有視聴者数ではなく、差分も真の離脱人数ではない。プラットフォーム間の重複は除けない。
- 時間加重平均は150秒以内で隣接する有効サンプルの台形積分。欠損や取得停止区間を除く。最大も「観測した最大」で、サービス公式のピークとは異なる場合がある。
- 雑談・ゲーム・結果などStudioのフェーズを同時記録する。チャット本文・視聴者IDは保存しない。
- 動画一覧はアップロードの新しい200本まで。6時間おきに更新。期間指標は前日までの28日、累計再生数とは区別する。AnalyticsのcreatorContentTypeを使い、尺からShortsと推定しない。
- 維持率はelapsedVideoTimeRatio / audienceWatchRatio。100%超も表示する。stoppedWatchingは視聴停止イベント数であって、固有人数ではない。区間の落差はパーセントポイントで表記する。
- 詳細取得は動画選択時、成功時6時間キャッシュ。集計遅延・プライバシー閾値による空データは未取得として表示する。
- ライブサンプルと詳細キャッシュは30日で削除。動画一覧は定期更新。改善実験の自作メモは保持する。API由来のベースライン値は30日後に削除し、自作メモは残す。
- サムネイルCTR、Shortsのスワイプ率、Twitchの個別滞在時間はこの画面では取得しない。YouTube Studio / Twitch管理画面を併用する。

## Analyticsの追加接続

YouTube Analytics APIを同じGoogle Cloudプロジェクトで有効にし、本人の承認を得て `node scripts/youtube-auth.mjs --analytics` を実行する。追加スコープは `yt-analytics.readonly` のみ。既存のコメント用認証を変更せず、data/youtube-analytics-oauth.jsonに0600で保存。本人がチャンネル所有アカウントを選んで承認したあと、画面の「動画データを更新」を押す。配信再起動は不要。収益・書き込み権限は要求しない。

## 改善の運用

1. 同じ種別・公開後日数・近い尺のコンテンツで比較する。
2. 維持率が落ちた時刻の動画リンクを開き、無音・説明・場面切替を確認する。相関だけで原因と断定しない。
3. 「改善実験ノート」に1つの変更、比較指標、確認日を保存。登録時の期間指標をベースラインとして保持する。
4. データが少ない場合は結論を保留。100再生は運用上の目安で統計的有意性を保証しない。
5. 再生数の定義が異なるShortsと通常動画を同じ順位で評価しない。ShortsはEngaged viewsも確認する。

APIは読み取りのみ。Jev/LLM/TTSは呼ばず、API枠を消費する。現在の配信を変更する操作も行わない。

公式仕様: https://developers.google.com/youtube/analytics/channel_reports 、https://developers.google.com/youtube/analytics/dimensions 、https://dev.twitch.tv/docs/api/reference/#get-streams
