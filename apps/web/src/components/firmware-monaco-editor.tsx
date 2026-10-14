'use client';

import Editor, { loader } from '@monaco-editor/react';

loader.config({ paths: { vs: '/monaco/vs' } });

export default Editor;
