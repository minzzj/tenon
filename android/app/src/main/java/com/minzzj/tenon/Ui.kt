package com.minzzj.tenon

import android.content.Context
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView

/** 程序化 UI 工具（深色证据板风格，与 Web 端一致：深空底 / 核对青 / 警示琥珀 / 纸白 / 辅助灰）。 */
object Ui {
    val BG = 0xFF070B14.toInt()
    val CARD = 0xFF0D1524.toInt()
    val CYAN = 0xFF66E3D2.toInt()
    val AMBER = 0xFFFFB45C.toInt()
    val PAPER = 0xFFE9F1FA.toInt()
    val GREY = 0xFF8FA3BD.toInt()
    val LINE = 0xFF23334A.toInt()

    fun dp(ctx: Context, v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()

    fun scroll(ctx: Context, root: LinearLayout): ScrollView = ScrollView(ctx).apply {
        setBackgroundColor(BG)
        isFillViewport = true
        addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    fun column(ctx: Context): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(BG)
        setPadding(dp(ctx, 16), dp(ctx, 16), dp(ctx, 16), dp(ctx, 32))
    }

    fun row(ctx: Context): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
    }

    fun title(ctx: Context, text: String): TextView = TextView(ctx).apply {
        this.text = text
        textSize = 24f
        setTextColor(PAPER)
        typeface = Typeface.create("sans-serif", Typeface.BOLD)
    }

    fun label(ctx: Context, text: String): TextView = TextView(ctx).apply {
        this.text = text
        textSize = 12f
        setTextColor(GREY)
        setPadding(0, dp(ctx, 6), 0, dp(ctx, 2))
    }

    fun body(ctx: Context, text: String = ""): TextView = TextView(ctx).apply {
        this.text = text
        textSize = 14f
        setTextColor(PAPER)
        setLineSpacing(dp(ctx, 3).toFloat(), 1f)
        setPadding(0, dp(ctx, 2), 0, dp(ctx, 2))
    }

    fun hint(ctx: Context, text: String): TextView = TextView(ctx).apply {
        this.text = text
        textSize = 12f
        setTextColor(GREY)
        setLineSpacing(dp(ctx, 2).toFloat(), 1f)
        setPadding(0, dp(ctx, 4), 0, dp(ctx, 4))
    }

    fun section(ctx: Context, title: String): LinearLayout {
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(dp(ctx, 14), dp(ctx, 12), dp(ctx, 14), dp(ctx, 14))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(ctx, 12) }
        }
        val head = TextView(ctx).apply {
            text = title
            textSize = 13f
            setTextColor(CYAN)
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
            letterSpacing = 0.08f
            setPadding(0, 0, 0, dp(ctx, 8))
        }
        box.addView(head)
        return box
    }

    fun input(ctx: Context, hintText: String, value: String = ""): EditText = EditText(ctx).apply {
        hint = hintText
        setText(value)
        textSize = 14f
        setTextColor(PAPER)
        setHintTextColor(GREY)
        setBackgroundResource(R.drawable.bg_input)
        setPadding(dp(ctx, 12), dp(ctx, 10), dp(ctx, 12), dp(ctx, 10))
        isSingleLine = true
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(ctx, 6) }
    }

    fun button(ctx: Context, text: String, primary: Boolean = false, onClick: () -> Unit): Button =
        Button(ctx).apply {
            this.text = text
            textSize = 14f
            isAllCaps = false
            setTextColor(if (primary) CYAN else PAPER)
            setBackgroundResource(if (primary) R.drawable.bg_btn_primary else R.drawable.bg_btn)
            minHeight = dp(ctx, 42)
            setPadding(dp(ctx, 14), dp(ctx, 8), dp(ctx, 14), dp(ctx, 8))
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { weight = 1f; rightMargin = dp(ctx, 6) }
        }

    fun spacer(ctx: Context, h: Int): View = View(ctx).apply {
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(ctx, h))
    }

    fun progress(ctx: Context): ProgressBar = ProgressBar(
        ctx, null, android.R.attr.progressBarStyleHorizontal
    ).apply {
        max = 100
        progress = 0
        progressTintList = android.content.res.ColorStateList.valueOf(CYAN)
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(ctx, 10)
        ).apply { topMargin = dp(ctx, 8) }
    }

    fun switchRow(ctx: Context, text: String, checked: Boolean, onChange: (Boolean) -> Unit): Switch =
        Switch(ctx).apply {
            this.text = text
            textSize = 14f
            setTextColor(PAPER)
            isChecked = checked
            setPadding(0, dp(ctx, 6), 0, dp(ctx, 6))
            setOnCheckedChangeListener { _, isOn -> onChange(isOn) }
        }
}