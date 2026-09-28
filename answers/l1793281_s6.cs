using System;

class Program
{
    static void Main()
    {
        for (int i = 1; i <= 10; i++)
        {
            if (i == 3 || i == 7)
            {
                continue;
            }
            Console.WriteLine(i);
        }
    }
}