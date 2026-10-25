package com.minzzj.tenon

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.Toast

/** 素材库浏览：直接打开 Web 端 #/assets（WebView），并注入 v2 访问令牌到 localStorage。 */
class AssetsActivity : Activity() {
    private lateinit var web: WebView
    private var injected = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
        }
        val bar = Ui.row(this)
        val title = Ui.title(this, "素材库")
        title.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        bar.addView(title)
        val close = Ui.button(this, "返回") { if (web.canGoBack()) web.goBack() else finish() }
        close.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 84), ViewGroup.LayoutParams.WRAP_CONTENT)
        bar.addView(close)
        root.addView(bar)

        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.cacheMode = WebSettings.LOAD_DEFAULT
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (!injected && App.token().isNotBlank()) {
                    injected = true
                    view?.evaluateJavascript(
                        "try{localStorage.setItem('tenon:token','${App.token().replace("'", "")}')}catch(e){}",
                        null
                    )
                    view?.reload()
                }
            }
        }
        root.addView(web, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        val base = App.baseUrl()
        if (base.isBlank()) {
            Toast.makeText(this, "请先在主界面配置中枢地址", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        web.loadUrl("$base/#/assets")
    }

    override fun onDestroy() {
        try {
            web.destroy()
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}