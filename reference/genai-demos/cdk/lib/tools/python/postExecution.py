import os

def upload_working_directory():
    cwd = os.getcwd()
    print(f"Uploading contents of current working directory ({cwd}) to S3...")
    for root, dirs, files in os.walk(cwd):
        for file in files:
            local_path = os.path.join(root, file)
            rel_path = os.path.relpath(local_path, cwd)
            if any(part.startswith('.') for part in rel_path.split(os.sep)):
                continue
            if '__pycache__' in rel_path.split(os.sep):
                continue
            if rel_path.startswith('global'):
                continue
            if local_path.lower().endswith('.html'):
                try:
                    with open(local_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    plotly_script = '<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>'
                    if plotly_script not in content:
                        if '</head>' in content:
                            content = content.replace('</head>', f'{plotly_script}\n</head>')
                        elif '<body>' in content:
                            content = content.replace('<body>', f'<body>\n{plotly_script}')
                        else:
                            content = f'{plotly_script}\n{content}'
                    import re
                    def get_full_url(file_path):
                        if file_path.startswith(('http://', 'https://')):
                            return file_path
                        if file_path.startswith('global/'):
                            return f"/file/{file_path}"
                        return f"/file/{chatSessionS3Prefix}{file_path}"
                    def replace_href(match):
                        return f'href="{get_full_url(match.group(1))}"'
                    def replace_src(match):
                        return f'src="{get_full_url(match.group(1))}"'
                    content = re.sub(r'href="([^"]+)"', replace_href, content)
                    content = re.sub(r'src="([^"]+)"', replace_src, content)
                    with open(local_path, 'w', encoding='utf-8') as f:
                        f.write(content)
                except Exception as e:
                    print(f"Error processing HTML links in {local_path}: {str(e)}")
            print(f"Uploading {local_path} to S3...")
            uploadFileToS3(local_path, rel_path)
    print("Finished uploading working directory to S3")

upload_working_directory()
