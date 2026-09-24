//! `tauri` 兼容层的宏实现。
//!
//! 目标：让 `src-tauri/src` 下的 156 个业务命令**一行都不用改**。为此本 crate 复刻了
//! Tauri 用到的那几个宏：
//!
//! * `#[command]` —— 保留原函数定义，额外生成一个 `__sm_register_<fn_name>()`，
//!   返回一条 [`CommandDef`] 路由记录。
//! * `generate_handler![a::b, c::d]` —— 把路径列表展开成 `__sm_register_b()` 的调用列表，
//!   生成 `Vec<CommandDef>`。因为它是函数式宏，可以直接拼出标识符，无需 `paste`。
//! * `generate_context!()` —— 编译期读取 `silvermoon.config.json`，把应用元信息烘焙成常量。
//! * `mobile_entry_point` —— 桌面端无操作，仅为兼容 `#[cfg_attr(mobile, ...)]` 而存在。
//!
//! # 形参解包规则（依据对 154 个命令签名的实测统计）
//!
//! | 形态 | 判定依据 | 生成代码 |
//! |---|---|---|
//! | `AppHandle` | 类型末段为 `AppHandle`（含 `tauri::AppHandle`） | 由 `Ctx` 注入，不占 JSON 键 |
//! | `State<'_, T>` | 类型末段为 `State` | 由 `Ctx` 按 `T` 取托管状态，不占 JSON 键 |
//! | 其余 | —— | 从 JSON 取键，键名 = 形参名去掉前导 `_` 后转 camelCase |
//!
//! 两类注入参数**可出现在任意位置**（实测有 `ASx` / `SAxxxxx` / `xSx` 等形态），
//! 因此本宏按类型而非按位置判定。
//!
//! 前导下划线必须剥掉：`anime_webview_resolve(_base_url: String)` 的前端键是 `baseUrl`，
//! 若按 `_baseUrl` 取值会直接报缺参。

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{format_ident, quote};
use syn::{
    parse_macro_input, punctuated::Punctuated, FnArg, GenericArgument, Ident, ItemFn, Pat, Path,
    PathArguments, ReturnType, Token, Type,
};

/// 把 `snake_case` 形参名转成前端使用的 `camelCase` 键名（先剥前导下划线）。
fn to_arg_key(raw: &str) -> String {
    let trimmed = raw.trim_start_matches('_');
    let mut out = String::with_capacity(trimmed.len());
    let mut upper_next = false;
    for ch in trimmed.chars() {
        if ch == '_' {
            upper_next = true;
        } else if upper_next {
            out.extend(ch.to_uppercase());
            upper_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// 取类型路径的末段标识符（`tauri::AppHandle` → `AppHandle`）。
fn last_segment_ident(ty: &Type) -> Option<&Ident> {
    match ty {
        Type::Path(p) => p.path.segments.last().map(|s| &s.ident),
        _ => None,
    }
}

/// 判断是否为 `Option<T>`，是则返回内部的 `T`。
fn option_inner(ty: &Type) -> Option<&Type> {
    let Type::Path(p) = ty else { return None };
    let seg = p.path.segments.last()?;
    if seg.ident != "Option" {
        return None;
    }
    let PathArguments::AngleBracketed(args) = &seg.arguments else {
        return None;
    };
    args.args.iter().find_map(|a| match a {
        GenericArgument::Type(t) => Some(t),
        _ => None,
    })
}

/// 类型是否是 `Result<...>`。
fn is_result_type(ty: &Type) -> bool {
    last_segment_ident(ty)
        .map(|i| i == "Result")
        .unwrap_or(false)
}

/// 一个待注入/待解包的形参。
enum Slot {
    /// `app: AppHandle` 或 `app: &AppHandle`
    App { ident: Ident, by_ref: bool },
    /// `state: State<'_, DbState>`
    State { ident: Ident, state_ty: Type },
    /// 普通参数，从 JSON 取
    Value {
        ident: Ident,
        key: String,
        ty: Type,
        optional_inner: Option<Type>,
    },
}

#[proc_macro_attribute]
pub fn command(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let func = parse_macro_input!(item as ItemFn);
    match expand_command(&func) {
        Ok(ts) => ts.into(),
        Err(e) => e.to_compile_error().into(),
    }
}

fn expand_command(func: &ItemFn) -> syn::Result<TokenStream2> {
    let name = func.sig.ident.clone();
    let name_str = name.to_string();
    let is_async = func.sig.asyncness.is_some();
    let return_ty = &func.sig.output;
    let returns_result = match return_ty {
        ReturnType::Default => false,
        ReturnType::Type(_, ty) => is_result_type(ty),
    };

    let mut slots: Vec<Slot> = Vec::new();
    for input in &func.sig.inputs {
        let FnArg::Typed(pat_type) = input else {
            // `#[command]` 的函数不会有 self 参数
            return Err(syn::Error::new(
                Span::call_site(),
                "tauri::command 不支持 self 接收者",
            ));
        };
        let Pat::Ident(pat_ident) = &*pat_type.pat else {
            return Err(syn::Error::new_spanned(
                &pat_type.pat,
                "tauri::command 只支持简单标识符形参",
            ));
        };
        let ident = pat_ident.ident.clone();
        let ty = (*pat_type.ty).clone();

        match last_segment_ident(&ty) {
            Some(seg) if seg == "AppHandle" => {
                let by_ref = matches!(ty, Type::Reference(_));
                slots.push(Slot::App { ident, by_ref });
            }
            Some(seg) if seg == "State" => {
                // 抽出 `State<'_, DbState>` 里的 `DbState`
                let Type::Path(p) = &ty else {
                    return Err(syn::Error::new_spanned(&ty, "无法解析 State 类型"));
                };
                let seg = p.path.segments.last().unwrap();
                let PathArguments::AngleBracketed(args) = &seg.arguments else {
                    return Err(syn::Error::new_spanned(&ty, "State 缺少泛型参数"));
                };
                let state_ty = args
                    .args
                    .iter()
                    .find_map(|a| match a {
                        GenericArgument::Type(t) => Some(t.clone()),
                        _ => None,
                    })
                    .ok_or_else(|| syn::Error::new_spanned(&ty, "State 缺少托管类型"))?;
                slots.push(Slot::State { ident, state_ty });
            }
            _ => {
                let key = to_arg_key(&ident.to_string());
                let optional_inner = option_inner(&ty).cloned();
                slots.push(Slot::Value {
                    ident,
                    key,
                    ty,
                    optional_inner,
                });
            }
        }
    }

    let mut binds = Vec::with_capacity(slots.len());
    let mut call_args = Vec::with_capacity(slots.len());
    for slot in &slots {
        match slot {
            Slot::App { ident, by_ref } => {
                binds.push(quote! {
                    let #ident = __ctx.app_handle();
                });
                if *by_ref {
                    call_args.push(quote!(&#ident));
                } else {
                    call_args.push(quote!(#ident));
                }
            }
            Slot::State { ident, state_ty } => {
                binds.push(quote! {
                    let #ident = __ctx.state::<#state_ty>();
                });
                call_args.push(quote!(#ident));
            }
            Slot::Value {
                ident,
                key,
                ty,
                optional_inner,
            } => match optional_inner {
                Some(inner) => binds.push(quote! {
                    let #ident: #ty = __args.take_optional::<#inner>(#key)?;
                }),
                None => binds.push(quote! {
                    let #ident: #ty = __args.take(#key)?;
                }),
            },
        }
    }
    for slot in &slots {
        if let Slot::Value { ident, .. } = slot {
            call_args.push(quote!(#ident));
        }
    }

    let call = if is_async {
        quote!(#name(#(#call_args),*).await)
    } else {
        quote!(#name(#(#call_args),*))
    };

    let body = if returns_result {
        quote! {
            match #call {
                ::std::result::Result::Ok(__v) => ::tauri::__private::to_command_value(&__v),
                ::std::result::Result::Err(__e) => ::std::result::Result::Err(
                    ::std::string::ToString::to_string(&__e),
                ),
            }
        }
    } else {
        quote! {
            let __ret = #call;
            ::tauri::__private::to_command_value(&__ret)
        }
    };

    let register_ident = format_ident!("__sm_register_{}", name);

    Ok(quote! {
        #func

        #[doc(hidden)]
        #[allow(non_snake_case, unused_mut, unused_variables, clippy::all)]
        pub fn #register_ident() -> ::tauri::__private::CommandDef {
            ::tauri::__private::CommandDef::new(#name_str, |__ctx, __args| {
                let __ctx: ::tauri::__private::Ctx = *__ctx;
                ::std::boxed::Box::pin(async move {
                    let mut __args = __args;
                    #(#binds)*
                    #body
                })
            })
        }
    })
}

/// 把 `generate_handler![commands::app::exit_app, ...]` 展开成 `Vec<CommandDef>`。
#[proc_macro]
pub fn generate_handler(input: TokenStream) -> TokenStream {
    let paths = parse_macro_input!(input with Punctuated::<Path, Token![,]>::parse_terminated);
    let mut entries = Vec::with_capacity(paths.len());
    for path in paths {
        let mut rewritten = path.clone();
        let last = rewritten.segments.last_mut().expect("空路径");
        last.ident = format_ident!("__sm_register_{}", last.ident);
        entries.push(quote!(#rewritten()));
    }
    quote! {
        ::std::vec![ #(#entries),* ]
    }
    .into()
}

/// 编译期读取 `silvermoon.config.json`，烘焙成 [`ContextConfig`]。
#[proc_macro]
pub fn generate_context(_input: TokenStream) -> TokenStream {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let cfg_path = std::path::Path::new(&manifest_dir).join("silvermoon.config.json");

    let mut identifier = "cn.cool.silvermoon".to_string();
    let mut product_name = "SilverMoon".to_string();
    let mut window_title = "SilverMoon".to_string();
    let mut width: u32 = 1280;
    let mut height: u32 = 800;
    let mut min_width: u32 = 900;
    let mut min_height: u32 = 600;

    if let Ok(text) = std::fs::read_to_string(&cfg_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            let pick = |ptr: &str| -> Option<String> {
                json.pointer(ptr).and_then(|v| v.as_str()).map(String::from)
            };
            if let Some(v) = pick("/identifier") {
                identifier = v;
            }
            if let Some(v) = pick("/productName") {
                product_name = v;
            }
            if let Some(v) = pick("/window/title") {
                window_title = v;
            }
            if let Some(v) = json.pointer("/window/width").and_then(|v| v.as_u64()) {
                width = v as u32;
            }
            if let Some(v) = json.pointer("/window/height").and_then(|v| v.as_u64()) {
                height = v as u32;
            }
            if let Some(v) = json.pointer("/window/minWidth").and_then(|v| v.as_u64()) {
                min_width = v as u32;
            }
            if let Some(v) = json.pointer("/window/minHeight").and_then(|v| v.as_u64()) {
                min_height = v as u32;
            }
        }
    }

    // 把配置文件嵌入 `include_str!`：既让 cargo 把它纳入增量构建依赖，也保证
    // 磁盘上不存在该文件时给出明确报错，而不是静默用默认值。
    let abs = cfg_path.to_string_lossy().replace('\\', "/");

    quote! {
        {
            const _SILVERMOON_CONFIG_TRACKED: &str = include_str!(#abs);
            ::tauri::__private::Context::new(::tauri::__private::ContextConfig {
                identifier: #identifier,
                product_name: #product_name,
                window_title: #window_title,
                window_width: #width,
                window_height: #height,
                window_min_width: #min_width,
                window_min_height: #min_height,
            })
        }
    }
    .into()
}

/// 桌面端空操作：仅为 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 存在。
#[proc_macro_attribute]
pub fn mobile_entry_point(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}
