# TimesFM Sandbox

TimesFMベースの時系列予測を行うためのSandbox環境を提供するmacOS向けデスクトップアプリケーションです。

## 主な機能
- **時系列予測**: GoogleのTimesFMモデルを用いた高精度な予測。
- **異常検知**: 予測値と実績値の解離に基づいた異常箇所の自動特定。
- **タイムゾーン対応**: 任意のタイムゾーンでのグラフ表示に対応。
- **効果推定（反実仮想予測）**: グラフ上をドラッグしてイベント（ノイズ）期間を選択し、そのイベントがなかった場合の「ifの世界」をシミュレーション。施策の効果測定などに活用可能。
- **マルチソース対応**: CSVアップロード、テキスト貼り付けに加え、Google Cloud StorageやBigQueryからの直接読み込みに対応。

## インストール方法

### Homebrew経由でのインストール（推奨）
Homebrewを使用することで、簡単にインストールおよびアップデート管理が可能です。

```bash
# カスタムtapを追加（初回のみ）してインストールする場合
brew tap blue1st/homebrew-taps
brew install --cask timesfm-sandbox

# または、1行で直接インストールする場合
brew install --cask blue1st/homebrew-taps/timesfm-sandbox
```

※ 本アプリは現在Appleの公証（Notarization）を取得していませんが、Cask経由でインストールした場合は自動で実行可能になるよう設定されているため、そのまま開くことができます。

## 開発に関する情報

### ローカルでの起動

```bash
npm install
npm run dev
```

### Docker Compose での起動

Docker を用いて、独立したコンテナでフロントエンドとバックエンドを同時に起動することも可能です。

```bash
docker compose up --build
```

起動後、ブラウザで [http://localhost:3000](http://localhost:3000) にアクセスするとアプリを利用できます。

- バックエンドは `http://localhost:8000` で動作します。
- モデルのダウンロードを高速化するため、ホストマシンの `~/.cache/huggingface` がコンテナ内にマウントされます。
- `JAX_PLATFORMS=cpu` が設定されており、CPU上での推論が行われます。

### 今後のリリース運用について

本リポジトリではCI（GitHub Actions）と `release-it` を用いた自動リリースフローを構成しています。新しいリリースを切る際は、以下のコマンドを実行してください。

```bash
npm run release
```

これを実行すると、対話式でバージョンアップの選択（patch / minor / major）が行われ、Gitタグの作成とPushまでが一括で行われます。  
GitHubに `v1.x.x` のようなタグがPushされると、GitHub Actions のプロセスが自動的に立ち上がり、**macOS向けバイナリのビルド・GitHub Releasesへのアップロード・HomebrewのCaskファイルの更新** のすべてが自動進行します。
