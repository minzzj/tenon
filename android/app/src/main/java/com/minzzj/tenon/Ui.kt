package com.minzzj.tenon

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
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
    /** 底部页签栏底色 / 未选中页签 / 离线红点（与电脑端 super.html 协调）。 */
    val TAB_BG = 0xFF0A111C.toInt()
    val DIM = 0xFF5E7391.toInt()
    val RED = 0xFFFF6B6B.toInt()
    val SEG_ON = 0xFF103532.toInt()

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
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        )
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

    // ============ 0.6.7：手机 5 页签清爽外壳（与电脑端 super.html 对齐） ============

    /** 整页容器：上方可滚动内容 + 底部固定 5 页签栏。 */
    fun page(activity: Activity, content: LinearLayout, current: String): LinearLayout {
        val col = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
        }
        val scroll = ScrollView(activity).apply {
            isFillViewport = true
            setBackgroundColor(BG)
            addView(
                content,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        col.addView(scroll)
        col.addView(View(activity).apply {
            setBackgroundColor(LINE)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(activity, 1))
        })
        col.addView(tabBar(activity, current))
        return col
    }

    /** 底部 5 页签（首页 / 记录 / 提醒 / 文档 / 设置），点击切换到对应页面。 */
    fun tabBar(activity: Activity, current: String): LinearLayout {
        val bar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(TAB_BG)
            setPadding(dp(activity, 4), dp(activity, 6), dp(activity, 4), dp(activity, 8))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        val defs = listOf(
            Triple(TabNav.HOME, "◉", "首页"),
            Triple(TabNav.RECORDS, "📝", "记录"),
            Triple(TabNav.REMINDERS, "⏰", "提醒"),
            Triple(TabNav.DOCUMENTS, "📄", "文档"),
            Triple(TabNav.SETTINGS, "⚙", "设置")
        )
        for ((key, icon, label) in defs) {
            val active = key == current
            val item = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                isClickable = true
                isFocusable = true
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener { TabNav.go(activity, key) }
            }
            item.addView(View(activity).apply {
                setBackgroundColor(if (active) CYAN else Color.TRANSPARENT)
                layoutParams = LinearLayout.LayoutParams(dp(activity, 18), dp(activity, 2))
            })
            item.addView(TextView(activity).apply {
                text = icon
                textSize = 14f
                gravity = Gravity.CENTER
                setTextColor(if (active) CYAN else DIM)
                setPadding(0, dp(activity, 4), 0, 0)
            })
            item.addView(TextView(activity).apply {
                text = label
                textSize = 10f
                gravity = Gravity.CENTER
                setTextColor(if (active) CYAN else GREY)
                typeface = Typeface.create("sans-serif", if (active) Typeface.BOLD else Typeface.NORMAL)
                setPadding(0, dp(activity, 1), 0, 0)
            })
            bar.addView(item)
        }
        return bar
    }

    /** 统一页头：大标题 + 一行说明（右侧配 action() 按钮）。 */
    fun pageHead(ctx: Context, title: String, subtitle: String = ""): LinearLayout {
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        col.addView(TextView(ctx).apply {
            text = title
            textSize = 23f
            setTextColor(PAPER)
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
        })
        if (subtitle.isNotBlank()) col.addView(TextView(ctx).apply {
            text = subtitle
            textSize = 11f
            setTextColor(GREY)
            setPadding(0, dp(ctx, 2), 0, 0)
        })
        return col
    }

    /** 页头右侧的小动作按钮（固定宽度，避免和标题抢空间）。 */
    fun action(ctx: Context, text: String, primary: Boolean = false, onClick: () -> Unit): Button {
        val b = button(ctx, text, primary, onClick)
        b.layoutParams = LinearLayout.LayoutParams(dp(ctx, 66), ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = dp(ctx, 6)
        }
        b.textSize = 13f
        b.minWidth = 0
        b.minimumWidth = 0
        return b
    }

    /** 分段控件（记录页：笔记 / 全天录音 / 屏幕记录）。 */
    fun segment(ctx: Context, labels: List<String>, selected: Int, onSelect: (Int) -> Unit): LinearLayout {
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            background = rounded(ctx, CARD, LINE, 9)
            setPadding(dp(ctx, 4), dp(ctx, 4), dp(ctx, 4), dp(ctx, 4))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        labels.forEachIndexed { index, label ->
            val on = index == selected
            box.addView(TextView(ctx).apply {
                text = label
                textSize = 13f
                gravity = Gravity.CENTER
                setTextColor(if (on) CYAN else GREY)
                typeface = Typeface.create("sans-serif", if (on) Typeface.BOLD else Typeface.NORMAL)
                setPadding(0, dp(ctx, 8), 0, dp(ctx, 8))
                background = rounded(
                    ctx,
                    if (on) SEG_ON else Color.TRANSPARENT,
                    if (on) CYAN else Color.TRANSPARENT,
                    7
                )
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener { onSelect(index) }
            })
        }
        return box
    }

    /** 程序化圆角背景（避免为每个小控件新增 drawable 资源）。 */
    fun rounded(ctx: Context, fill: Int, stroke: Int, radiusDp: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(fill)
            cornerRadius = dp(ctx, radiusDp).toFloat()
            if (stroke != Color.TRANSPARENT) setStroke(dp(ctx, 1), stroke)
        }

    /** 小号灰字（列表元信息）。 */
    fun meta(ctx: Context, text: String): TextView = TextView(ctx).apply {
        this.text = text
        textSize = 11f
        setTextColor(DIM)
        setLineSpacing(dp(ctx, 2).toFloat(), 1f)
        setPadding(0, dp(ctx, 2), 0, 0)
    }

    /** 列表卡片容器（统一样式，可整体点击）。 */
    fun listCard(ctx: Context, onClick: (() -> Unit)? = null): LinearLayout =
        LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(dp(ctx, 14), dp(ctx, 10), dp(ctx, 14), dp(ctx, 12))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(ctx, 8) }
            if (onClick != null) {
                isClickable = true
                setOnClickListener { onClick() }
            }
        }
}