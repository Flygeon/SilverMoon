package cn.cool.silvermoon.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.cool.silvermoon.design.silverMoon

/**
 * 尚未迁移完成的页面。
 *
 * 刻意不留空白页：写清楚"数据面到哪一步了、视图差什么"，
 * 让接手的人知道是后端没桥接还是纯粹没画。
 */
@Composable
fun PlaceholderScreen(title: String, summary: String) {
    val tokens = silverMoon
    Column(
        modifier = Modifier.fillMaxSize().padding(tokens.contentPadding),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.width(12.dp))
            AssistChip(onClick = {}, label = { Text("视图待迁移") })
        }
        Text(
            text = summary,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
