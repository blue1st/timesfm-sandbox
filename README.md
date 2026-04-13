# TimesFM Sandbox

TimesFMベースの時系列予測を行うためのSandbox環境を提供するmacOS向けデスクトップアプリケーションです。

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

### 今後のリリース運用について

本リポジトリではCI（GitHub Actions）と `release-it` を用いた自動リリースフローを構成しています。新しいリリースを切る際は、以下のコマンドを実行してください。

```bash
npm run release
```

これを実行すると、対話式でバージョンアップの選択（patch / minor / major）が行われ、Gitタグの作成とPushまでが一括で行われます。  
GitHubに `v1.x.x` のようなタグがPushされると、GitHub Actions のプロセスが自動的に立ち上がり、**macOS向けバイナリのビルド・GitHub Releasesへのアップロード・HomebrewのCaskファイルの更新** のすべてが自動進行します。
