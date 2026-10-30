package com.minzzj.tenon

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.Toast

/** 通用二级页：用 WebView 打开中枢的页面（设备绑定/一键安装、手机遥控、素材库等）。 */
class WebPageActivity : Activity() {
    companion object {
        const val EXTRA_TITLE = "title"
        const val EXTRA_URL = "url"
    }

    private lateinit var web: WebView
    private var injected = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "榫卯"
        val url = intent.getStringExtra(EXTRA_URL) ?: ""
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
        }
        val bar = Ui.row(this)
        val t = Ui.title(this, title)
        t.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        bar.addView(t)
        val close = Ui.button(this, "返回") { if (web.canGoBack()) web.goBack() else finish() }
        close.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 84), ViewGroup.LayoutParams.WRAP_CONTENT)
        bar.addView(close)
        root.addView(bar)

        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.cacheMode = WebSettings.LOAD_DEFAULT
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, u: String?) {
                super.onPageFinished(view, u)
                if (!injected && App.token().isNotBlank()) {
                    injected = true
                    view?.evaluateJavascript(
                        "try{localStorage.setItem('tenon:token','" + App.token().replace("'", "") + "')}catch(e){}",
                        null
                    )
                    view?.reload()
                }
            }
        }
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        if (url.isBlank()) { Toast.makeText(this, "页面地址为空", Toast.LENGTH_SHORT).show(); finish(); return }
        web.loadUrl(url)
    }

    override fun onBackPressed() {
        if (this::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        try { web.destroy() } catch (_: Exception) {}
        super.onDestroy()
    }
}
