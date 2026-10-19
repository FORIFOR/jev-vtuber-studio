#!/usr/bin/env node
import { resolve } from 'node:path';
import { OBS } from '../src/obs.mjs';
import { parseSwitchCheckArgs, readSwitchConfig, inspectSwitchReadiness } from '../src/switch-readiness.mjs';

const usage = `Switch配信の読み取り専用診断
  node scripts/switch-check.mjs [--studio-dir /path/to/Jev_VTuber_Studio] [--pi-host raspberrypi.local]

--studio-dir 未指定: この診断スクリプトのあるチェックアウトの .env と data/settings.json を読む。
--studio-dir 指定: 指定した Studio の設定ファイルだけを読む。コードは実行しない。
--pi-host は接続先の指定有無の記録のみ。SSH接続・自動操作は行わない。
OBSの設定変更、配信/録画開始、キャプチャデバイスのオープン、API課金は行わない。
終了コード 0: 診断完了（配信準備完了ではない）、1: OBS接続等が未確認、2: 引数/設定エラー。`;

try {
    const options = parseSwitchCheckArgs(process.argv.slice(2), resolve(import.meta.dirname, '..'));
    if (options.help) console.log(usage);
    else {
        const c = readSwitchConfig(options.studioDir);
        const report = await inspectSwitchReadiness({ obs: new OBS(c), piHost: options.piHost });
        report.configuration = { found: c.configurationFound, passwordConfigured: !!c.obsPassword };
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = report.obs.connection === 'connected' ? 0 : 1;
    }
} catch {
    // Errors may contain a URL, secret configuration value or device identifier.
    console.error('Switch診断: 引数または設定を読み取れませんでした。--help と設定ファイルを確認してください（値は非表示）。');
    process.exitCode = 2;
}
