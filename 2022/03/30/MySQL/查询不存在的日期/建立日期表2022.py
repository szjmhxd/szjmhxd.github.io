# 引入 PyMySQL
import pymysql
import datetime

# 连接数据库
conn = pymysql.connect(
    host='127.0.0.1',         # 主机名
    user='root',              # 用户名
    passwd='root',          # 密码
    db='test',          # 数据库名
    port=3306,                # 端口
    charset='utf8'            # 编码
)

# 使用cursor()方法获取操作游标
cursor = conn.cursor()

#如果存在{db_name}表，则删除
cursor.execute("DROP TABLE IF EXISTS date2022")

#创建{db_name}表
sql = """
    create table date2022(
    id int(0) NOT NULL,
    date date NULL DEFAULT NULL
    )
"""

try:
    # 执行SQL语句
    cursor.execute(sql)
    print("创建数据库成功")
except Exception as e:
    print("创建数据库失败：case%s"%e)
    
d1 = datetime.datetime.strptime('2022-01-01', '%Y-%m-%d')
delta = datetime.timedelta(days=1)
d2 = d1

i = 1
n = 365
while i <= n:

    sql = 'insert into date2022(id , date) values(%s, %s)'
    param = (i, d2)

    cursor.execute(sql, param)
    i += 1    
    d2 = d2 + delta
    print("next", i)
    print("#############")

# 提交事务
conn.commit()
print("数据插入完成")


# 最后，关闭游标
cursor.close()
# 提交事务
conn.commit()
# 关闭连接
conn.close()